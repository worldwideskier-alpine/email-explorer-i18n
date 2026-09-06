import { env } from "cloudflare:test";
import PostalMime from "postal-mime";
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
		// It names the attachment it stands for, and does not answer to its
		// name: nothing should mistake the note for the file.
		expect(entry).toContain("note.bin");
		expect(entry).not.toContain('filename="note.bin"');
		expect(entry).not.toContain("Content-Transfer-Encoding: base64");
	});

	/**
	 * And the mark survives being read back, which is the only thing that makes
	 * it a mark at all.
	 *
	 * The first version of this put the note's headers *after* the original
	 * `Content-Type` and `Content-Disposition`, so the part carried two of each
	 * and a reader keeps the first. Through postal-mime that came back as
	 * `note.bin`, `application/octet-stream`, 36 bytes, containing the apology
	 * -- a plausible corrupt file, which is worse than the silence it replaced.
	 */
	it("still says so after the archive is parsed back", async () => {
		const id = `sent-${crypto.randomUUID()}`;

		const entry = text(await renderMboxEntry(env, email(id) as never, "Sent"));
		// Past the mbox separator line, which is not part of the message.
		const message = entry.slice(entry.indexOf("\r\n") + 2);
		const parsed = await PostalMime.parse(message);

		expect(parsed.attachments.map((one) => one.filename)).not.toContain(
			"note.bin",
		);
		const restored = parsed.attachments.map((one) =>
			typeof one.content === "string"
				? one.content
				: new TextDecoder().decode(one.content as ArrayBuffer),
		);
		// Whatever it comes back as, it is not something that looks like the
		// file: either no attachment at all, or one that says what happened.
		for (const body of restored) {
			expect(body).toContain("could not be read");
		}
		expect(`${parsed.text ?? ""}${restored.join("")}`).toContain(
			"could not be read",
		);
	});

	/**
	 * The bytes come back as the bytes, at every length around the line.
	 *
	 * base64Lines used to build the whole encoding, then cut it into lines with
	 * a regex. It now encodes 57 bytes at a time, which is one line exactly --
	 * a cheaper way to the same string, and the only thing worth asserting
	 * about it is that it really is the same string. The lengths are the ones
	 * that would break a chunked encoder: either side of the line, either side
	 * of the three bytes base64 works in, and empty.
	 */
	it("round-trips the attachment at every awkward length", async () => {
		for (const length of [1, 2, 3, 56, 57, 58, 113, 114, 115, 1000]) {
			const payload = new Uint8Array(length);
			for (let i = 0; i < length; i++) payload[i] = (i * 7 + 13) % 256;

			const id = `sent-${crypto.randomUUID()}`;
			await env.BUCKET.put(`attachments/${id}/att-1/note.bin`, payload);

			const entry = text(
				await renderMboxEntry(env, email(id) as never, "Sent"),
			);
			const parsed = await PostalMime.parse(
				entry.slice(entry.indexOf("\r\n") + 2),
			);

			const back = parsed.attachments.find(
				(one) => one.filename === "note.bin",
			);
			expect(back, `length ${length}`).toBeTruthy();
			const bytes = new Uint8Array(back?.content as ArrayBuffer);
			expect(Array.from(bytes), `length ${length}`).toEqual(
				Array.from(payload),
			);

			/*
			 * And wrapped where it says it is. The round trip above passes on
			 * any line length -- postal-mime joins the lines before decoding,
			 * so it cannot tell 57 bytes from 58 -- which makes it no test of
			 * the chunk size at all. RFC 2045 puts the limit at 76 characters,
			 * and a reader that enforces it is the one that would find out.
			 */
			const encoded = entry
				.slice(entry.indexOf("Content-Transfer-Encoding: base64"))
				.split("\r\n\r\n")[1]
				?.split("\r\n--")[0];
			const lines = (encoded ?? "").split("\r\n").filter(Boolean);
			expect(lines.length, `length ${length}`).toBe(
				Math.ceil(length / 57) || 0,
			);
			for (const [at, line] of lines.entries()) {
				// Full but for the last, which carries whatever is left.
				expect(line.length, `length ${length} line ${at}`).toBe(
					at === lines.length - 1 ? line.length : 76,
				);
				expect(line.length).toBeLessThanOrEqual(76);
			}
		}
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
