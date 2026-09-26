import {
	createExecutionContext,
	env,
	runInDurableObject,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	authenticatedFetch,
	createMailbox,
	mailboxId,
	testAuthBeforeAll,
	userId,
} from "./utils";

const PUSH_ENDPOINT = "https://push.example.test/subscription/test-endpoint";

function base64UrlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

// A Web Push subscription's p256dh must be a real point on the P-256 curve
// for @pushforge/builder's ECDH step to succeed, so generate a real keypair
// rather than using random bytes.
async function generateTestSubscriptionKeys() {
	const keyPair = await crypto.subtle.generateKey(
		{ name: "ECDH", namedCurve: "P-256" },
		true,
		["deriveBits"],
	);
	const rawPublicKey = await crypto.subtle.exportKey("raw", keyPair.publicKey);
	const p256dh = base64UrlEncode(new Uint8Array(rawPublicKey));
	const auth = base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));
	return { p256dh, auth };
}

async function subscriptionCount(): Promise<number> {
	// @ts-expect-error
	const authId = env.MAILBOX.idFromName("AUTH");
	// @ts-expect-error
	const authDO = env.MAILBOX.get(authId);
	const subs = await authDO.getPushSubscriptionsForUsers([userId]);
	return subs.length;
}

/** An inbox message whose new-mail notification went out, unless told not. */
async function insertEmail(id: string, read = false, notified = true) {
	// @ts-expect-error
	const doId = env.MAILBOX.idFromName(mailboxId);
	// @ts-expect-error
	const doStub = env.MAILBOX.get(doId);
	await runInDurableObject(doStub, async (_instance, state) => {
		state.storage.sql.exec(
			`INSERT INTO emails (id, folder_id, subject, sender, recipient, date, body, read, notified)
			 VALUES (?, 'inbox', 'Test Subject', 'sender@example.com', ?, ?, '<p>Body</p>', ?, ?)`,
			id,
			mailboxId,
			new Date().toISOString(),
			read ? 1 : 0,
			notified ? 1 : 0,
		);
	});
}

describe("Push notification dismissal on read", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createMailbox();
	});

	it("sends a dismiss push to subscribed devices when an email is marked read", async () => {
		const { p256dh, auth } = await generateTestSubscriptionKeys();

		await authenticatedFetch("http://local.test/api/v1/push/subscribe", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ endpoint: PUSH_ENDPOINT, keys: { p256dh, auth } }),
		});
		expect(await subscriptionCount()).toBe(1);

		const emailId = crypto.randomUUID();
		await insertEmail(emailId, false);

		const response = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/emails/${emailId}`,
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ read: true }),
			},
		);

		expect(response.status).toBe(200);
		// The mocked push endpoint reports the subscription as gone (410),
		// which only happens if the dismiss push was actually sent — proving
		// PutEmail triggered the cross-device dismissal.
		expect(await subscriptionCount()).toBe(0);
	});

	it("sends nothing for a message no device was told about", async () => {
		const { p256dh, auth } = await generateTestSubscriptionKeys();
		await authenticatedFetch("http://local.test/api/v1/push/subscribe", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ endpoint: PUSH_ENDPOINT, keys: { p256dh, auth } }),
		});

		const emailId = crypto.randomUUID();
		await insertEmail(emailId, false, false);

		const response = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/emails/${emailId}`,
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ read: true }),
			},
		);
		expect(response.status).toBe(200);
		expect(await subscriptionCount()).toBe(1);
	});

	/**
	 * Dismissing it once is the whole job. Reading, unreading and reading
	 * again used to send one every time.
	 */
	it("dismisses a notification once", async () => {
		const emailId = crypto.randomUUID();
		await insertEmail(emailId, false);
		const read = (value: boolean) =>
			authenticatedFetch(
				`http://local.test/api/v1/mailboxes/${mailboxId}/emails/${emailId}`,
				{
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ read: value }),
				},
			);
		// Read before any device subscribed: the flag is spent here.
		expect((await read(true)).status).toBe(200);
		await read(false);

		const { p256dh, auth } = await generateTestSubscriptionKeys();
		await authenticatedFetch("http://local.test/api/v1/push/subscribe", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ endpoint: PUSH_ENDPOINT, keys: { p256dh, auth } }),
		});
		expect((await read(true)).status).toBe(200);
		expect(await subscriptionCount()).toBe(1);
	});

	/**
	 * Delivery marks what it announced. Without the mark, nothing received
	 * would ever be dismissed.
	 */
	it("marks mail it announced, and only that", async () => {
		const { p256dh, auth } = await generateTestSubscriptionKeys();
		await authenticatedFetch("http://local.test/api/v1/push/subscribe", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ endpoint: PUSH_ENDPOINT, keys: { p256dh, auth } }),
		});
		const worker = await import("../../dev/index");
		const deliver = async (subject: string) => {
			const bytes = new TextEncoder().encode(
				`From: a@example.org\r\nTo: ${mailboxId}\r\nSubject: ${subject}\r\n\r\nbody`,
			);
			await worker.default.email(
				{
					raw: new ReadableStream({
						start(c) {
							c.enqueue(bytes);
							c.close();
						},
					}),
					rawSize: bytes.length,
					to: mailboxId,
					setReject: () => {},
				},
				env,
				createExecutionContext(),
			);
		};
		await deliver("announced");
		// The mocked endpoint answered 410, so the subscription is gone and
		// the next message reaches no device.
		expect(await subscriptionCount()).toBe(0);
		await deliver("unannounced");

		// @ts-expect-error
		const doStub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
		const flags = await runInDurableObject(doStub, async (_i, state) =>
			state.storage.sql
				.exec("SELECT subject, notified FROM emails ORDER BY subject")
				.toArray(),
		);
		expect(flags).toEqual([
			{ subject: "announced", notified: 1 },
			{ subject: "unannounced", notified: 0 },
		]);
	});

	it("does not send a push when only starred status changes", async () => {
		const { p256dh, auth } = await generateTestSubscriptionKeys();

		await authenticatedFetch("http://local.test/api/v1/push/subscribe", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ endpoint: PUSH_ENDPOINT, keys: { p256dh, auth } }),
		});
		expect(await subscriptionCount()).toBe(1);

		const emailId = crypto.randomUUID();
		await insertEmail(emailId, false);

		const response = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/emails/${emailId}`,
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ starred: true }),
			},
		);

		expect(response.status).toBe(200);
		// No push was sent, so the mocked 410 never fired and the
		// subscription is untouched.
		expect(await subscriptionCount()).toBe(1);
	});
});
