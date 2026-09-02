import { createExecutionContext, env } from "cloudflare:test";
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

function buildRawEmail(headers: Record<string, string>, body: string): string {
	let raw = "";
	for (const [key, value] of Object.entries(headers)) {
		raw += `${key}: ${value}\r\n`;
	}
	raw += `\r\n${body}`;
	return raw;
}

async function simulateReceiveEmail(
	rawEmailStr: string,
	envelopeTo: string = mailboxId,
) {
	const worker = await import("../../dev/index");
	const rawBytes = new TextEncoder().encode(rawEmailStr);
	const stream = new ReadableStream({
		start(controller) {
			controller.enqueue(rawBytes);
			controller.close();
		},
	});

	// The envelope recipient is what the worker files mail by; the "To:"
	// header inside rawEmailStr is deliberately allowed to say anything else.
	await worker.default.email(
		{ raw: stream, rawSize: rawBytes.length, to: envelopeTo },
		env,
		createExecutionContext(),
	);
}

describe("New-mail push notification includes the mailbox label", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
	});

	it("still notifies subscribed devices when the mailbox has a display name set", async () => {
		await createMailbox({ fromName: "うおたスキー" });

		const { p256dh, auth } = await generateTestSubscriptionKeys();
		await authenticatedFetch("http://local.test/api/v1/push/subscribe", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ endpoint: PUSH_ENDPOINT, keys: { p256dh, auth } }),
		});
		expect(await subscriptionCount()).toBe(1);

		const rawEmail = buildRawEmail(
			{
				From: "sender@external.com",
				To: mailboxId,
				Subject: "Mailbox label test",
				"Content-Type": "text/plain",
				"Message-ID": "<label-test@external.com>",
			},
			"Body text",
		);

		await simulateReceiveEmail(rawEmail);

		// The mocked push endpoint reports the subscription as gone (410),
		// which only happens if notifyMailboxSubscribers successfully built
		// and sent the notification (title now includes the mailbox label)
		// without the new settings lookup throwing.
		expect(await subscriptionCount()).toBe(0);
	});

	it("still notifies subscribed devices when the mailbox has no display name set", async () => {
		await createMailbox();

		const { p256dh, auth } = await generateTestSubscriptionKeys();
		await authenticatedFetch("http://local.test/api/v1/push/subscribe", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ endpoint: PUSH_ENDPOINT, keys: { p256dh, auth } }),
		});
		expect(await subscriptionCount()).toBe(1);

		const rawEmail = buildRawEmail(
			{
				From: "sender@external.com",
				To: mailboxId,
				Subject: "No label test",
				"Content-Type": "text/plain",
				"Message-ID": "<no-label-test@external.com>",
			},
			"Body text",
		);

		await simulateReceiveEmail(rawEmail);

		expect(await subscriptionCount()).toBe(0);
	});
});
