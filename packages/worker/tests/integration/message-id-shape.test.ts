import {
	createExecutionContext,
	env,
	runInDurableObject,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { asMessageId, messageIdsIn } from "../../src/message-id";
import { sendEmail } from "../../src/resend";
import {
	authenticatedFetch,
	createDummyMailbox,
	mailboxId,
	personId,
	testAuthBeforeAll,
} from "./utils";

/**
 * A Message-ID is a sender's string, and a reply writes it into two headers.
 *
 * postal-mime decodes RFC 2047 encoded words in these headers, so an encoded
 * CR LF came out of ingest as a real line break and was stored; a reply put it
 * straight into In-Reply-To and References -- a header of the sender's own in
 * our outgoing mail, or one Resend refused, leaving the message unanswerable.
 * Only something shaped like a msg-id is kept, and a reply asks again.
 */

async function receive(headers: Record<string, string>) {
	const raw = `${Object.entries(headers)
		.map(([k, v]) => `${k}: ${v}`)
		.join("\r\n")}\r\n\r\nbody`;
	const bytes = new TextEncoder().encode(raw);
	const worker = await import("../../dev/index");
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
		},
		env,
		createExecutionContext(),
	);
}

const inbox = async (subject: string) =>
	(
		await (
			await authenticatedFetch(
				`http://local.test/api/v1/mailboxes/${mailboxId}/emails?folder=inbox`,
			)
		).json<any[]>()
	).find((e) => e.subject === subject);

/** CR LF, then a header of the sender's choosing, as an encoded word. */
const INJECTED =
	"=?utf-8?Q?<a=0D=0ABcc:_victim@example.net=0D=0AX:_y@x.example>?=";

describe("a Message-ID with a line break in it", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
	});

	it("is not stored, nor are such references", async () => {
		await receive({
			From: "sender@example.net",
			To: mailboxId,
			Subject: "injected",
			"Message-ID": INJECTED,
			"In-Reply-To": INJECTED,
			References: `<fine@example.net> ${INJECTED}`,
		});
		const row = await inbox("injected");
		expect(row).toBeDefined();
		const full = await (
			await authenticatedFetch(
				`http://local.test/api/v1/mailboxes/${mailboxId}/emails/${row.id}`,
			)
		).json<any>();
		for (const value of [
			full.message_id,
			full.in_reply_to,
			full.email_references,
			full.thread_id,
		]) {
			expect(String(value ?? "")).not.toMatch(/[\r\n]|Bcc:/);
		}
		expect(full.message_id).toBeNull();
		expect(JSON.parse(full.email_references)).toEqual(["fine@example.net"]);
	});

	it("keeps an ordinary one", async () => {
		await receive({
			From: "sender@example.net",
			To: mailboxId,
			Subject: "ordinary",
			"Message-ID": "<CAF+x.y_z=1@mail.example.net>",
		});
		const row = await inbox("ordinary");
		const full = await (
			await authenticatedFetch(
				`http://local.test/api/v1/mailboxes/${mailboxId}/emails/${row.id}`,
			)
		).json<any>();
		expect(full.message_id).toBe("CAF+x.y_z=1@mail.example.net");
	});
});

/**
 * Rows stored before ingest asked are still there, so the reply asks again
 * rather than trusting what it finds.
 */
describe("a reply to a message stored with such an id", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
	});

	it("names no header the sender wrote", async () => {
		const id = crypto.randomUUID();
		const bad = "a\r\nBcc: victim@example.net";
		await runInDurableObject(
			env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId)),
			async (_instance, state) => {
				state.storage.sql.exec(
					`INSERT INTO emails (id, folder_id, subject, sender, recipient, date, body, message_id, email_references)
					 VALUES (?, 'inbox', 'old', 'sender@example.net', ?, ?, '<p>x</p>', ?, ?)`,
					id,
					mailboxId,
					new Date().toISOString(),
					bad,
					JSON.stringify(["fine@example.net", bad, "x@y z"]),
				);
			},
		);
		const response = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/emails/${id}/reply`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					to: "sender@example.net",
					from: mailboxId,
					subject: "Re: ECHO_RESEND_REQUEST",
					html: "<p>reply</p>",
				}),
			},
		);
		// The stub hands the request back as the failure message.
		const sent = JSON.parse(
			(await response.json<{ error: string }>()).error.replace(
				/^Resend API error: 500 /,
				"",
			),
		);
		expect(sent.headers).toEqual({ References: "<fine@example.net>" });
	});

	it("keeps no such id on its sent copy either", async () => {
		const id = crypto.randomUUID();
		await runInDurableObject(
			env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId)),
			async (_instance, state) => {
				state.storage.sql.exec(
					`INSERT INTO emails (id, folder_id, subject, sender, recipient, date, body, message_id)
					 VALUES (?, 'inbox', 'old', 'sender@example.net', ?, ?, '<p>x</p>', ?)`,
					id,
					mailboxId,
					new Date().toISOString(),
					"a\r\nBcc: victim@example.net",
				);
			},
		);
		const reply = await (
			await authenticatedFetch(
				`http://local.test/api/v1/mailboxes/${mailboxId}/emails/${id}/reply`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						to: "sender@example.net",
						from: mailboxId,
						subject: "Re: old",
						html: "<p>reply</p>",
					}),
				},
			)
		).json<{ id: string }>();
		const copy = await (
			await authenticatedFetch(
				`http://local.test/api/v1/mailboxes/${mailboxId}/emails/${reply.id}`,
			)
		).json<any>();
		expect(copy.in_reply_to).toBeNull();
		expect(copy.email_references ?? "[]").not.toMatch(/Bcc/);
	});
});

/** And the send itself, whoever calls it with whatever. */
describe("the headers of a message sent", () => {
	beforeEach(testAuthBeforeAll);

	it("carry only ids", async () => {
		const failure = await sendEmail(
			env,
			{
				from: mailboxId,
				to: "x@example.net",
				subject: "ECHO_RESEND_REQUEST",
				html: "<p>x</p>",
				inReplyTo: "a\r\nBcc: victim@example.net",
				references: ["ok@example.net", "b\nX: y@z"],
			},
			personId,
		).catch((e: Error) => e.message);
		const sent = JSON.parse(
			String(failure).replace(/^Resend API error: 500 /, ""),
		);
		expect(sent.headers).toEqual({ References: "<ok@example.net>" });
	});
});

describe("asMessageId and messageIdsIn", () => {
	it("take an id, and nothing that could end a header", () => {
		expect(asMessageId("<a.b@c.example>")).toBe("a.b@c.example");
		expect(asMessageId(" x+y@[127.0.0.1] ")).toBe("x+y@[127.0.0.1]");
		for (const bad of [
			"a\r\nb@c",
			"a@b\nX: y",
			"a b@c",
			"a b@c",
			"a\u0000@b",
			"a@b@c",
			"@b",
			"a@",
			"<<a@b>>",
			"",
			`${"a".repeat(300)}@b`,
			undefined,
		]) {
			expect(asMessageId(bad)).toBeNull();
		}
	});

	it("read References by its brackets, or word by word without any", () => {
		expect(messageIdsIn("<a@b> <c@d>")).toEqual(["a@b", "c@d"]);
		expect(messageIdsIn("a@b  c@d")).toEqual(["a@b", "c@d"]);
		expect(messageIdsIn("<x\r\nBcc: v@e> <ok@e>")).toEqual(["ok@e"]);
		expect(messageIdsIn(undefined)).toEqual([]);
	});
});
