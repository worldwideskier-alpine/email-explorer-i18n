import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	authenticatedFetch,
	createDummyMailbox,
	mailboxId,
	testAuthBeforeAll,
} from "./utils";

/**
 * A message with many attachments.
 *
 * Every attachment row went into one INSERT, seven variables a row, and a
 * statement may bind 100: the fifteenth attachment was refused. The email row
 * had already been written by then, so a message sent with fifteen files went
 * out through Resend and was missing from Sent, and one received with fifteen
 * left its files in R2 with no row that names them.
 */

const MANY = 40;

const files = (n: number) =>
	Array.from({ length: n }, (_, i) => ({
		content: btoa(`file ${i}`),
		filename: `file-${i}.txt`,
		type: "text/plain",
		disposition: "attachment",
	}));

async function onlyMessageIn(folder: string) {
	const list = await authenticatedFetch(
		`http://local.test/api/v1/mailboxes/${mailboxId}/emails?folder=${folder}`,
	);
	const emails = await list.json<{ id: string }[]>();
	expect(emails, `messages in ${folder}`).toHaveLength(1);
	const detail = await authenticatedFetch(
		`http://local.test/api/v1/mailboxes/${mailboxId}/emails/${emails[0].id}`,
	);
	return detail.json<{ id: string; attachments: { filename: string }[] }>();
}

function rawWithAttachments(n: number): string {
	const boundary = "b-many";
	const parts = Array.from({ length: n }, (_, i) =>
		[
			`--${boundary}`,
			`Content-Type: text/plain; name="part-${i}.txt"`,
			`Content-Disposition: attachment; filename="part-${i}.txt"`,
			"Content-Transfer-Encoding: base64",
			"",
			btoa(`part ${i}`),
		].join("\r\n"),
	);
	return [
		"From: sender@example.org",
		`To: ${mailboxId}`,
		"Subject: many parts",
		"MIME-Version: 1.0",
		`Content-Type: multipart/mixed; boundary="${boundary}"`,
		"",
		`--${boundary}`,
		"Content-Type: text/plain; charset=UTF-8",
		"",
		"see attached",
		...parts,
		`--${boundary}--`,
		"",
	].join("\r\n");
}

describe("a message with many attachments", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
	});

	it("is sent and kept in Sent with every one of them", async () => {
		const res = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/emails`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					from: mailboxId,
					to: "someone@example.org",
					subject: "many files",
					text: "see attached",
					attachments: files(MANY),
				}),
			},
		);
		expect(res.status).toBe(201);
		const sent = await onlyMessageIn("sent");
		expect(sent.attachments).toHaveLength(MANY);
	});

	it("is received with every one of them", async () => {
		const res = await authenticatedFetch(
			`http://local.test/api/v1/admin/mailboxes/${mailboxId}/import`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					folder: "inbox",
					rawEmailBase64: btoa(rawWithAttachments(MANY)),
				}),
			},
		);
		expect(res.status).toBe(201);
		const received = await onlyMessageIn("inbox");
		expect(received.attachments).toHaveLength(MANY);
	});

	// The same, asked of the Durable Object directly. Through a route, an
	// error from the object leaves this test pool hanging rather than
	// failing, so this is the one that says what went wrong.
	it("is stored by the mailbox with every one of them", async () => {
		const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
		await runInDurableObject(stub, async (instance) => {
			const mailbox = instance as unknown as {
				createEmail: (...a: unknown[]) => Promise<void>;
				getEmail: (id: string) => Promise<{ attachments: unknown[] } | null>;
			};
			await mailbox.createEmail(
				"inbox",
				{
					id: "many",
					subject: "s",
					sender: "sender@example.org",
					recipient: mailboxId,
					date: new Date().toISOString(),
					read: false,
					starred: false,
					body: "b",
				},
				Array.from({ length: MANY }, (_, i) => ({
					id: `a${i}`,
					email_id: "many",
					filename: `f${i}.txt`,
					mimetype: "text/plain",
					size: 1,
					content_id: null,
					disposition: "attachment",
				})),
			);
			expect((await mailbox.getEmail("many"))?.attachments).toHaveLength(MANY);
		});
	});

	// The message and its rows go in together: a message whose rows could
	// not be written is not left behind without them.
	it("is not kept at all when its attachment rows cannot be written", async () => {
		const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
		const row = (id: string) => ({
			id,
			email_id: "half",
			filename: "f.txt",
			mimetype: "text/plain",
			size: 1,
			content_id: null,
			disposition: "attachment",
		});
		// Called on the instance rather than through the stub: a rejection
		// crossing RPC is also reported by the pool as unhandled.
		await runInDurableObject(stub, async (instance) => {
			const mailbox = instance as unknown as {
				createEmail: (...a: unknown[]) => Promise<void>;
				getEmail: (id: string) => Promise<unknown>;
			};
			await expect(
				mailbox.createEmail(
					"inbox",
					{
						id: "half",
						subject: "s",
						sender: "sender@example.org",
						recipient: mailboxId,
						date: new Date().toISOString(),
						read: false,
						starred: false,
						body: "b",
					},
					// The same attachment id twice breaks the primary key.
					[row("a1"), row("a1")],
				),
			).rejects.toThrow("UNIQUE");
			expect(await mailbox.getEmail("half")).toBeNull();
		});
	});
});
