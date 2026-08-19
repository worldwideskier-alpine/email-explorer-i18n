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
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function generateTestSubscriptionKeys() {
	const keyPair = await crypto.subtle.generateKey(
		{ name: "ECDH", namedCurve: "P-256" },
		true,
		["deriveBits"],
	);
	const raw = await crypto.subtle.exportKey("raw", keyPair.publicKey);
	return {
		p256dh: base64UrlEncode(new Uint8Array(raw)),
		auth: base64UrlEncode(crypto.getRandomValues(new Uint8Array(16))),
	};
}

async function subscriptionCount(): Promise<number> {
	// @ts-expect-error
	const authDO = env.MAILBOX.get(env.MAILBOX.idFromName("AUTH"));
	return (await authDO.getPushSubscriptionsForUsers([userId])).length;
}

async function subscribe() {
	const keys = await generateTestSubscriptionKeys();
	await authenticatedFetch("http://local.test/api/v1/push/subscribe", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ endpoint: PUSH_ENDPOINT, keys }),
	});
}

async function insertUnreadInboxEmail(id: string) {
	// @ts-expect-error
	const doStub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
	await runInDurableObject(doStub, async (_i, state) => {
		state.storage.sql.exec(
			`INSERT INTO emails (id, folder_id, subject, sender, recipient, date, body, read)
			 VALUES (?, 'inbox', '未読メール', 'spammer@example.com', ?, ?, '<p>b</p>', 0)`,
			id,
			mailboxId,
			new Date().toISOString(),
		);
	});
}

const setVerdict = (id: string, verdict: "spam" | "not-spam") =>
	authenticatedFetch(
		`http://local.test/api/v1/mailboxes/${mailboxId}/emails/${id}/spam-verdict`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ verdict }),
		},
	);

const getEmail = async (id: string) =>
	(await (
		await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/emails/${id}`,
		)
	).json()) as any;

const listFolder = async (folder: string) =>
	(await (
		await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/emails?folder=${folder}&limit=100`,
		)
	).json()) as any[];

describe("Marking an email as spam", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createMailbox();
	});

	it("moves it to the spam folder rather than deleting it", async () => {
		const id = crypto.randomUUID();
		await insertUnreadInboxEmail(id);

		expect((await setVerdict(id, "spam")).status).toBe(200);

		// Still there, just filed elsewhere
		expect((await getEmail(id)).subject).toBe("未読メール");
		expect((await listFolder("spam")).some((e) => e.id === id)).toBe(true);
		expect((await listFolder("inbox")).some((e) => e.id === id)).toBe(false);
	});

	it("marks it read so it stops counting as unread", async () => {
		const id = crypto.randomUUID();
		await insertUnreadInboxEmail(id);
		expect((await getEmail(id)).read).toBe(false);

		await setVerdict(id, "spam");

		expect((await getEmail(id)).read).toBe(true);
	});

	it("clears the notification still showing on the phone", async () => {
		const id = crypto.randomUUID();
		await insertUnreadInboxEmail(id);
		await subscribe();
		expect(await subscriptionCount()).toBe(1);

		await setVerdict(id, "spam");

		// The mocked push endpoint answers 410, so the subscription only gets
		// pruned if a dismiss push was actually sent for this email.
		expect(await subscriptionCount()).toBe(0);
	});

	it("leaves mail rescued from spam unread so it still gets noticed", async () => {
		const id = crypto.randomUUID();
		await insertUnreadInboxEmail(id);
		await setVerdict(id, "spam");
		expect((await getEmail(id)).read).toBe(true);

		await setVerdict(id, "not-spam");

		expect((await listFolder("inbox")).some((e) => e.id === id)).toBe(true);
		// not-spam must not silently re-mark it read
		expect((await getEmail(id)).read).toBe(true);
	});
});
