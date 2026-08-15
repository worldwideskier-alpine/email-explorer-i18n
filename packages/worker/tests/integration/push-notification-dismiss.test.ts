import { env, runInDurableObject } from "cloudflare:test";
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

async function insertEmail(id: string, read = false) {
	// @ts-expect-error
	const doId = env.MAILBOX.idFromName(mailboxId);
	// @ts-expect-error
	const doStub = env.MAILBOX.get(doId);
	await runInDurableObject(doStub, async (_instance, state) => {
		state.storage.sql.exec(
			`INSERT INTO emails (id, folder_id, subject, sender, recipient, date, body, read)
			 VALUES (?, 'inbox', 'Test Subject', 'sender@example.com', ?, ?, '<p>Body</p>', ?)`,
			id,
			mailboxId,
			new Date().toISOString(),
			read ? 1 : 0,
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
