import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { renderMboxEntry } from "../../src/mbox";

/**
 * The attachments of a message that has no raw form.
 *
 * A received message is archived from the `raw/{id}.eml` it arrived as, and
 * its attachments are inside that. A message this fork composed or forwarded
 * has no raw form, so the archive is built from the row and the attachments
 * are fetched one by one -- and that read asked for `attachments/{id}`, while
 * every writer in the Worker stores `attachments/{emailId}/{attachmentId}/
 * {filename}` (index.ts:766, reply-forward.ts:142 and :260, email-ingest.ts:58;
 * the deletes in spam-purge-run.ts:68 and mailbox-destroy.ts:79 agree).
 *
 * So the get always missed, and the miss was a bare `continue`. Every sent
 * message with an attachment was archived without it, and said nothing about
 * it -- in a file nobody opens until the message has been deleted and the
 * archive is the only copy there is.
 *
 * Nothing covered this branch. The archive was checked with imported mail,
 * which has a raw form and never reaches it.
 */

// 48 bytes is 64 characters of base64, which base64Lines leaves on one
// line -- long enough to be a payload, short enough to assert as a string.
const attached = new Uint8Array(48).fill(0x41);

const email = (id: string) => ({
	id,
	folder_id: "sent",
	subject: "with an attachment",
	sender: "me@example.test",
	recipient: "you@example.test",
	date: "2026-09-06T00:00:00.000Z",
	read: true,
	starred: false,
	body: "<p>see attached</p>",
	attachments: [
		{
			id: "att-1",
			email_id: id,
			filename: "note.bin",
			mimetype: "application/octet-stream",
			size: attached.byteLength,
		},
	],
});

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("archiving a message that has no raw form", () => {
	it("carries the attachment, from the key the writers use", async () => {
		const id = `sent-${crypto.randomUUID()}`;
		await env.BUCKET.put(`attachments/${id}/att-1/note.bin`, attached);

		const entry = text(await renderMboxEntry(env, email(id) as never, "Sent"));

		// The payload itself, not just the part headers around it.
		expect(entry).toContain(btoa(String.fromCharCode(...attached)));
		expect(entry).toContain('filename="note.bin"');
		expect(entry).toContain("Content-Transfer-Encoding: base64");
		expect(entry).not.toContain("X-Email-Explorer-Attachment-Missing");
	});

	/**
	 * And one that is genuinely gone leaves a mark. A message archived without
	 * the attachment it had, and without a word about it, reads as a message
	 * that never had one -- which is the same silence the whole of this file's
	 * history has been about.
	 */
	it("says so when the attachment cannot be read", async () => {
		const id = `sent-${crypto.randomUUID()}`;
		// Deliberately not stored.

		const entry = text(await renderMboxEntry(env, email(id) as never, "Sent"));

		expect(entry).toContain("X-Email-Explorer-Attachment-Missing: 1");
		expect(entry).toContain("att-1");
		expect(entry).toContain('filename="note.bin"');
	});

	// A message with a raw form still comes from the raw form, untouched.
	it("prefers the raw message when there is one", async () => {
		const id = `recv-${crypto.randomUUID()}`;
		await env.BUCKET.put(
			`raw/${id}.eml`,
			"Subject: as it arrived\r\n\r\nthe original bytes",
		);
		await env.BUCKET.put(`attachments/${id}/att-1/note.bin`, attached);

		const entry = text(await renderMboxEntry(env, email(id) as never, "Inbox"));

		expect(entry).toContain("the original bytes");
		expect(entry).not.toContain("Content-Transfer-Encoding: base64");
	});
});
