import { describe, expect, it } from "vitest";
import {
	charsetsForAttachments,
	declaredParts,
	typeWithCharset,
} from "../../src/attachment-charset";

/**
 * Reading the parts of a message back out of its bytes.
 *
 * The integration tests put real messages through ingestion and look at the
 * rows. These hold the two decisions underneath that: which parts are files
 * rather than bodies, and what happens when that reading and the parser's do
 * not agree. The second is the one worth pinning -- the answer is "nothing at
 * all", and the cost of getting it wrong is a file relabelled as an encoding
 * it is not.
 */

const bytes = (text: string) => new TextEncoder().encode(text);

const MESSAGE = bytes(
	[
		"From: a@b.test",
		'Content-Type: multipart/mixed; boundary="b"',
		"",
		"--b",
		'Content-Type: text/plain; charset="utf-8"',
		"",
		"the body",
		"--b",
		"Content-Type: text/plain; charset=Shift_JIS",
		'Content-Disposition: attachment; filename="note.txt"',
		"",
		"c2hpZnQ=",
		"--b--",
	].join("\r\n"),
);

describe("reading the parts of a message", () => {
	it("tells a file apart from the body it sits beside", () => {
		const parts = declaredParts(MESSAGE);
		expect(parts.map((p) => `${p.type}/${p.attachmentLike}`)).toEqual([
			"multipart/mixed/false",
			"text/plain/false",
			"text/plain/true",
		]);
	});

	/**
	 * And takes the file's charset, not the body's. Both parts declare
	 * `text/plain`; a reader that took the first match put the body's utf-8 on
	 * the attachment, which is how this was written the first time.
	 */
	it("takes the charset of the file and not of the body", () => {
		expect(
			charsetsForAttachments(MESSAGE, [{ mimeType: "text/plain" }]),
		).toEqual(["Shift_JIS"]);
	});

	// The safety valve, and the whole reason this is allowed to guess at all.
	it("gives nothing when the two readings disagree", () => {
		expect(
			charsetsForAttachments(MESSAGE, [
				{ mimeType: "text/plain" },
				{ mimeType: "text/plain" },
			]),
		).toEqual([null, null]);
		expect(
			charsetsForAttachments(MESSAGE, [{ mimeType: "application/pdf" }]),
		).toEqual([null]);
	});

	it("has nothing to say about a message with no attachments", () => {
		expect(charsetsForAttachments(MESSAGE, [])).toEqual([]);
	});

	// An attachment with no name at all is still a file: the disposition says
	// so, and that shape is the one that was mis-stored for months.
	it("counts a nameless attachment as a file", () => {
		const nameless = bytes(
			[
				'Content-Type: multipart/mixed; boundary="b"',
				"",
				"--b",
				"Content-Type: text/plain",
				"",
				"body",
				"--b",
				"Content-Type: text/csv; charset=Shift_JIS",
				"Content-Disposition: attachment",
				"",
				"data",
				"--b--",
			].join("\r\n"),
		);
		expect(
			charsetsForAttachments(nameless, [{ mimeType: "text/csv" }]),
		).toEqual(["Shift_JIS"]);
	});
});

describe("what gets stored as the type", () => {
	it("adds the charset to text and nothing else", () => {
		expect(typeWithCharset("text/plain", "Shift_JIS")).toBe(
			"text/plain; charset=Shift_JIS",
		);
		expect(typeWithCharset("TEXT/HTML", "EUC-JP")).toBe(
			"TEXT/HTML; charset=EUC-JP",
		);
		expect(typeWithCharset("application/pdf", "Shift_JIS")).toBe(
			"application/pdf",
		);
		expect(typeWithCharset("text/plain", null)).toBe("text/plain");
		expect(typeWithCharset(undefined, "Shift_JIS")).toBe("");
	});
});
