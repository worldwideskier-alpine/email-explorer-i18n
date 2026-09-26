import {
	createExecutionContext,
	env,
	runInDurableObject,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { storableFilename } from "../../src/attachment-name";
import {
	authenticatedFetch,
	createDummyMailbox,
	mailboxId,
	sessionToken,
	testAuthBeforeAll,
	userId,
} from "./utils";

/**
 * What a received message keeps of what the sender wrote: a filename of any
 * length, everyone in a group, and -- when marking it read cannot reach the
 * devices -- the fact that it was marked read.
 */

async function receive(raw: string, e: object = env) {
	const worker = await import("../../dev/index");
	const bytes = new TextEncoder().encode(raw);
	const rejections: string[] = [];
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
			setReject: (reason: string) => rejections.push(reason),
		},
		e,
		createExecutionContext(),
	);
	return rejections;
}

async function inbox() {
	return (
		await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/emails?folder=inbox`,
		)
	).json<{ id: string; subject: string; recipient: string; cc: string }[]>();
}

describe("a received message", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
	});

	/**
	 * The name goes into the attachment's key, and R2 refuses a key over 1024
	 * bytes. A 1000-byte name refused the whole message, after its original
	 * had been written.
	 */
	it("is kept, and its attachment opens, whatever the attachment is called", async () => {
		const name = `${"長".repeat(340)}.pdf`;
		const encoded = `=?UTF-8?B?${btoa(
			String.fromCharCode(...new TextEncoder().encode(name)),
		)}?=`;
		const raw = [
			"From: a@example.org",
			`To: ${mailboxId}`,
			"Subject: long name",
			"MIME-Version: 1.0",
			'Content-Type: multipart/mixed; boundary="b"',
			"",
			"--b",
			"Content-Type: text/plain",
			"",
			"see attached",
			"--b",
			`Content-Type: application/pdf; name="${encoded}"`,
			`Content-Disposition: attachment; filename="${encoded}"`,
			"Content-Transfer-Encoding: base64",
			"",
			btoa("%PDF-1.4 content"),
			"--b--",
			"",
		].join("\r\n");

		expect(await receive(raw)).toEqual([]);
		const [message] = await inbox();
		expect(message?.subject).toBe("long name");

		const detail = await (
			await authenticatedFetch(
				`http://local.test/api/v1/mailboxes/${mailboxId}/emails/${message.id}`,
			)
		).json<{ attachments: { id: string; filename: string }[] }>();
		const [attachment] = detail.attachments;
		expect(attachment.filename).toBe(storableFilename(name));
		expect(attachment.filename.endsWith("….pdf")).toBe(true);

		const download = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/emails/${message.id}/attachments/${attachment.id}`,
		);
		expect(download.status).toBe(200);
		expect(await download.text()).toBe("%PDF-1.4 content");
	});

	/** `Team: a, b;` is one entry to the parser, with no address of its own. */
	it("keeps everyone in a group", async () => {
		const raw = [
			"From: a@example.org",
			`To: ${mailboxId}, Team: one@example.org, two@example.org;`,
			"Cc: Others: three@example.org;",
			"Subject: group",
			"",
			"body",
		].join("\r\n");

		expect(await receive(raw)).toEqual([]);
		const [message] = await inbox();
		expect(message.recipient).toBe(
			`${mailboxId}, one@example.org, two@example.org`,
		);
		const detail = await (
			await authenticatedFetch(
				`http://local.test/api/v1/mailboxes/${mailboxId}/emails/${message.id}`,
			)
		).json<{ cc: string }>();
		expect(detail.cc).toBe("three@example.org");
	});
});

describe("marking a message read", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
	});

	/**
	 * The dismissal runs after the read state is stored. A key the push
	 * library cannot read used to throw out of it, and a change that had
	 * happened came back as a 500.
	 */
	it("succeeds when the devices cannot be told", async () => {
		expect(
			await receive(
				`From: a@example.org\r\nTo: ${mailboxId}\r\nSubject: s\r\n\r\nbody`,
			),
		).toEqual([]);
		const [message] = await inbox();
		// @ts-expect-error test binding
		const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
		await stub.markNotified(message.id);
		// @ts-expect-error test binding
		const auth = env.MAILBOX.get(env.MAILBOX.idFromName("AUTH"));
		await runInDurableObject(auth, async (_i, state) => {
			state.storage.sql.exec(
				"INSERT INTO push_subscriptions (id, user_id, session_id, endpoint, p256dh, auth, created_at) VALUES ('p', ?, ?, 'https://push.example.net/x', 'k', 'a', 0)",
				userId,
				sessionToken,
			);
		});

		const worker = await import("../../dev/index");
		const res = await worker.default.fetch(
			new Request(
				`http://local.test/api/v1/mailboxes/${mailboxId}/emails/${message.id}`,
				{
					method: "PUT",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${sessionToken}`,
					},
					body: JSON.stringify({ read: true }),
				},
			),
			{ ...(env as object), VAPID_PRIVATE_KEY: "not json" },
			createExecutionContext(),
		);
		expect(res.status).toBe(200);
	});
});
