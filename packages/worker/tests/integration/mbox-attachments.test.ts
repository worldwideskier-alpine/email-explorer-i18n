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

	/**
	 * The name is the sender's text, and it goes into a quoted parameter.
	 *
	 * postal-mime hands back filenames holding quotes from ordinary mail. The
	 * name was interpolated straight in, so one closed the string early and
	 * `a"; name="x.txt` came back as an attachment called `a` with the rest
	 * read as a second parameter. What is archived has to be what was sent.
	 */
	it("keeps a filename that contains a quote", async () => {
		const id = `sent-${crypto.randomUUID()}`;
		const awkward = 'a"; name="x.txt';
		await env.BUCKET.put(`attachments/${id}/att-1/${awkward}`, attached);

		const one = { ...email(id) };
		one.attachments = [{ ...one.attachments[0], filename: awkward }];
		const entry = text(await renderMboxEntry(env, one as never, "Sent"));
		const parsed = await PostalMime.parse(
			entry.slice(entry.indexOf("\r\n") + 2),
		);

		expect(parsed.attachments.map((a) => a.filename)).toEqual([awkward]);
	});

	/**
	 * And a name holding a line ending cannot write lines of its own. RFC 2231
	 * percent-encoding lets one through the parser, and from there it was going
	 * straight into a header and into the note's prose.
	 */
	it("does not let a filename inject lines into the archive", async () => {
		const id = `sent-${crypto.randomUUID()}`;
		const injecting = "x\r\nX-Injected: yes\r\nContent-Type: text/evil";

		const one = { ...email(id) };
		one.attachments = [{ ...one.attachments[0], filename: injecting }];
		// Deliberately not stored, so the note's prose carries the name too.
		const entry = text(await renderMboxEntry(env, one as never, "Sent"));

		/*
		 * The words still appear -- inside the quoted parameter, and inside the
		 * note, where they are the name and not instructions. What must not
		 * exist is a *line* of them, so that is what is asserted: "the text is
		 * absent" would be a stronger claim than the fix makes, and a weaker
		 * test than the fix needs.
		 */
		for (const line of entry.split("\r\n")) {
			expect(line.startsWith("X-Injected")).toBe(false);
			expect(line.startsWith("Content-Type: text/evil")).toBe(false);
		}
		const parsed = await PostalMime.parse(
			entry.slice(entry.indexOf("\r\n") + 2),
		);
		expect(
			parsed.headers.find((h) => h.key.toLowerCase() === "x-injected"),
		).toBeUndefined();
	});

	// The type is the sender's text as well.
	it("does not let a content type inject lines either", async () => {
		const id = `sent-${crypto.randomUUID()}`;
		await env.BUCKET.put(`attachments/${id}/att-1/note.bin`, attached);

		const one = { ...email(id) };
		one.attachments = [
			{ ...one.attachments[0], mimetype: "text/plain\r\nX-Injected: yes" },
		];
		const entry = text(await renderMboxEntry(env, one as never, "Sent"));

		for (const line of entry.split("\r\n")) {
			expect(line.startsWith("X-Injected")).toBe(false);
		}
	});

	/**
	 * The note comes back as something, through this fork's own restore.
	 *
	 * An inline text part is not what the import reads: it takes the parsed
	 * HTML body and the parsed attachments, and postal-mime folds an inline
	 * note into neither -- so the message was restored with no attachment and
	 * no word about one. A mark that only exists while nobody looks is the
	 * silence it was meant to replace.
	 */
	it("leaves the note where a restore will find it", async () => {
		const id = `sent-${crypto.randomUUID()}`;
		// Deliberately not stored.

		const entry = text(await renderMboxEntry(env, email(id) as never, "Sent"));
		const parsed = await PostalMime.parse(
			entry.slice(entry.indexOf("\r\n") + 2),
		);

		expect(parsed.attachments.length).toBe(1);
		const note = parsed.attachments[0];
		expect(note?.filename).toBe("note.bin.missing.txt");
		const body =
			typeof note?.content === "string"
				? note.content
				: new TextDecoder().decode(note?.content as ArrayBuffer);
		expect(body).toContain("could not be read");
	});

	/**
	 * A name that is not ASCII keeps its suffix inside the encoding.
	 *
	 * `${encodeHeader(name)}.missing.txt` puts text after an encoded word, and
	 * text after an encoded word is not part of it: a conforming reader shows
	 * `=?UTF-8?B?5paH5pu4LnBkZg==?=.missing.txt` as those characters. The whole
	 * name has to be encoded together.
	 *
	 * There was no test with a name outside ASCII at all, so nothing here could
	 * tell the two apart -- the fixture's `note.bin` encodes to itself.
	 */
	it("names the note properly when the filename is not ASCII", async () => {
		const id = `sent-${crypto.randomUUID()}`;
		// Deliberately not stored, so the note is what comes back.

		const one = { ...email(id) };
		one.attachments = [{ ...one.attachments[0], filename: "文書.pdf" }];
		const entry = text(await renderMboxEntry(env, one as never, "Sent"));
		const parsed = await PostalMime.parse(
			entry.slice(entry.indexOf("\r\n") + 2),
		);

		expect(parsed.attachments[0]?.filename).toBe("文書.pdf.missing.txt");
		expect(entry).not.toContain("?=.missing.txt");
	});

	/**
	 * A name that already looks like an encoded word stays that text.
	 *
	 * `encodeHeader` passed printable ASCII through, and "=?" opens an encoded
	 * word: an attachment sent as `=?utf-8?B?ZXZpbA==?=.txt` was archived
	 * verbatim and read back as `evil.txt`. Both names are the sender's, which
	 * is the point -- the archive has to hold what was sent.
	 */
	it("does not let a filename decode itself into another name", async () => {
		const id = `sent-${crypto.randomUUID()}`;
		const disguised = "=?utf-8?B?ZXZpbA==?=.txt";
		await env.BUCKET.put(`attachments/${id}/att-1/${disguised}`, attached);

		const one = { ...email(id) };
		one.attachments = [{ ...one.attachments[0], filename: disguised }];
		const entry = text(await renderMboxEntry(env, one as never, "Sent"));
		const parsed = await PostalMime.parse(
			entry.slice(entry.indexOf("\r\n") + 2),
		);

		expect(parsed.attachments[0]?.filename).toBe(disguised);
		expect(parsed.attachments[0]?.filename).not.toBe("evil.txt");
	});

	/**
	 * The stored type cannot turn the part into a container.
	 *
	 * `type` is an unvalidated string on the send API, and it was written as
	 * the part's Content-Type after nothing but a line-ending strip. Stored as
	 * `multipart/mixed; boundary="zz"`, the part becomes a container and the
	 * base64 inside it is read as a preamble: the archive parses back with no
	 * attachment at all, and says nothing about one having been there.
	 */
	it("does not let a content type swallow the attachment", async () => {
		const id = `sent-${crypto.randomUUID()}`;
		await env.BUCKET.put(`attachments/${id}/att-1/note.bin`, attached);

		const one = { ...email(id) };
		one.attachments = [
			{ ...one.attachments[0], mimetype: 'multipart/mixed; boundary="zz"' },
		];
		const entry = text(await renderMboxEntry(env, one as never, "Sent"));
		const parsed = await PostalMime.parse(
			entry.slice(entry.indexOf("\r\n") + 2),
		);

		expect(parsed.attachments.length).toBe(1);
		expect(parsed.attachments[0]?.mimeType).toBe("application/octet-stream");
		const back = new Uint8Array(parsed.attachments[0]?.content as ArrayBuffer);
		expect(Array.from(back)).toEqual(Array.from(attached));
	});

	// And a type that is simply a type is kept, minus its parameters.
	it("keeps an ordinary content type", async () => {
		const id = `sent-${crypto.randomUUID()}`;
		await env.BUCKET.put(`attachments/${id}/att-1/note.bin`, attached);

		const one = { ...email(id) };
		one.attachments = [
			{ ...one.attachments[0], mimetype: "image/PNG; name=x" },
		];
		const entry = text(await renderMboxEntry(env, one as never, "Sent"));
		const parsed = await PostalMime.parse(
			entry.slice(entry.indexOf("\r\n") + 2),
		);

		expect(parsed.attachments[0]?.mimeType).toBe("image/png");
	});

	/**
	 * An inline image keeps the identity its `cid:` refers to.
	 *
	 * The row holds `content_id` and `disposition`, and the export wrote
	 * neither: every inline image came back as a plain attachment, and every
	 * `cid:` in the restored body pointed at nothing.
	 */
	it("keeps the content id of an inline image", async () => {
		const id = `sent-${crypto.randomUUID()}`;
		await env.BUCKET.put(`attachments/${id}/att-1/note.bin`, attached);

		const one = { ...email(id) };
		one.attachments = [
			{
				...one.attachments[0],
				mimetype: "image/png",
				content_id: "<hero@example.test>",
				disposition: "inline",
			},
		];
		const entry = text(await renderMboxEntry(env, one as never, "Sent"));
		const parsed = await PostalMime.parse(
			entry.slice(entry.indexOf("\r\n") + 2),
		);

		expect(entry).toContain("Content-ID: <hero@example.test>");
		expect(entry).toContain("Content-Disposition: inline;");
		expect(parsed.attachments[0]?.contentId).toBe("<hero@example.test>");
	});

	/**
	 * An inline *text* attachment stays an attachment.
	 *
	 * Writing the stored `inline` for every part was the fix for cid: images,
	 * and it cost text ones their existence: a reader returns a text part as an
	 * attachment only when it is marked `attachment`, and folds an inline one
	 * into the body. Measured on this parser: `attachments: 0`, with the file's
	 * contents spliced into both `text` and `html`. In the file that is the
	 * last copy, and reachable from the send API, which takes any `type`
	 * alongside `disposition: "inline"`.
	 */
	it("keeps an inline text attachment as an attachment", async () => {
		for (const mimetype of ["text/plain", "text/html", "message/rfc822"]) {
			const id = `sent-${crypto.randomUUID()}`;
			await env.BUCKET.put(`attachments/${id}/att-1/notes.txt`, attached);

			const one = { ...email(id) };
			one.attachments = [
				{
					...one.attachments[0],
					filename: "notes.txt",
					mimetype,
					content_id: "<x@example.test>",
					disposition: "inline",
				},
			];
			const entry = text(await renderMboxEntry(env, one as never, "Sent"));
			const parsed = await PostalMime.parse(
				entry.slice(entry.indexOf("\r\n") + 2),
			);

			expect(parsed.attachments.length, mimetype).toBe(1);
			expect(parsed.attachments[0]?.filename, mimetype).toBe("notes.txt");
			const back = new Uint8Array(
				parsed.attachments[0]?.content as ArrayBuffer,
			);
			expect(Array.from(back), mimetype).toEqual(Array.from(attached));
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
