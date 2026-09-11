import { createExecutionContext, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	authenticatedFetch,
	createDummyMailbox,
	mailboxId,
	testAuthBeforeAll,
} from "./utils";

/**
 * A text attachment keeps the encoding it arrived in.
 *
 * postal-mime returns a bare `mimeType`, so `text/plain; charset=Shift_JIS`
 * reached the row as `text/plain` and the charset was gone at ingest -- before
 * anything that could have used it. What reads that row is the download
 * route's `Content-Type`, the archive of any message with no raw copy, and the
 * part a forward builds. Each of them then says "text/plain" to a reader that
 * defaults to UTF-8, and every byte of a Shift_JIS file becomes U+FFFD.
 *
 * The message still says so itself, in the copy stored beside it, and that is
 * where this now reads it from.
 *
 * The fixtures use real Shift_JIS bytes rather than a label over UTF-8 ones:
 * the point is a file that genuinely cannot be read as UTF-8, so a test that
 * passed by accident under the old behaviour is not possible.
 */

const PASSING_AUTH =
	"mx.test; spf=pass smtp.mailfrom=legit.com; dkim=pass header.i=@legit.com; dmarc=pass header.from=legit.com";

/** 「日本語」in Shift_JIS. Not valid UTF-8 by any reading. */
const SHIFT_JIS = new Uint8Array([0x93, 0x7a, 0x96, 0x7b, 0x8c, 0xea]);

const base64 = (bytes: Uint8Array) => {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
};

function message(parts: string[]): string {
	return [
		"From: sender@legit.com",
		`To: ${mailboxId}`,
		"Subject: an attachment with an encoding",
		'Content-Type: multipart/mixed; boundary="b"',
		"",
		"--b",
		'Content-Type: text/plain; charset="utf-8"',
		"",
		"see attached",
		...parts,
		"--b--",
	].join("\r\n");
}

/** One attachment part, with whatever Content-Type line is being tested. */
const part = (contentType: string[], filename: string, bytes: Uint8Array) => [
	"--b",
	...contentType,
	`Content-Disposition: attachment; filename="${filename}"`,
	"Content-Transfer-Encoding: base64",
	"",
	base64(bytes),
];

async function receive(raw: string) {
	const worker = await import("../../dev/index");
	const bytes = new TextEncoder().encode(raw);
	await worker.default.email(
		{
			raw: new ReadableStream({
				start(controller) {
					controller.enqueue(bytes);
					controller.close();
				},
			}),
			rawSize: bytes.length,
			to: mailboxId,
			headers: new Headers({ "Authentication-Results": PASSING_AUTH }),
			setReject: () => {},
		} as never,
		env,
		createExecutionContext(),
	);
}

/** The attachments of the one message in the inbox, as the mailbox reports. */
async function attachments() {
	const list = await authenticatedFetch(
		`http://local.test/api/v1/mailboxes/${mailboxId}/emails?folder=inbox&limit=10`,
	);
	const emails = await list.json<{ id: string }[]>();
	const one = await authenticatedFetch(
		`http://local.test/api/v1/mailboxes/${mailboxId}/emails/${emails[0]?.id}`,
	);
	const email = await one.json<{
		id: string;
		attachments?: { id: string; filename: string; mimetype: string }[];
	}>();
	return { id: email.id, list: email.attachments ?? [] };
}

describe("the encoding a text attachment arrived in", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
	});

	it("is what the row records", async () => {
		await receive(
			message(
				part(
					['Content-Type: text/plain; charset=Shift_JIS; name="note.txt"'],
					"note.txt",
					SHIFT_JIS,
				),
			),
		);
		const { list } = await attachments();
		expect(list).toHaveLength(1);
		expect(list[0]?.mimetype).toBe("text/plain; charset=Shift_JIS");
	});

	/**
	 * And what the download says, which is where a person meets it: the bytes
	 * were always right, and the header telling the browser to read them as
	 * UTF-8 is what turned the file into replacement characters on screen.
	 */
	it("reaches the download that serves it", async () => {
		await receive(
			message(
				part(
					['Content-Type: text/plain; charset=Shift_JIS; name="note.txt"'],
					"note.txt",
					SHIFT_JIS,
				),
			),
		);
		const { id, list } = await attachments();
		const response = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/emails/${id}/attachments/${list[0]?.id}`,
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe(
			'text/plain; charset="Shift_JIS"',
		);
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(SHIFT_JIS);
	});

	// Header folding is ordinary in mail, and the parameter is exactly what
	// ends up on the second line when the first one is full.
	it("survives being written across two lines", async () => {
		await receive(
			message(
				part(
					["Content-Type: text/plain;", "\tcharset=EUC-JP"],
					"note.txt",
					SHIFT_JIS,
				),
			),
		);
		const { list } = await attachments();
		expect(list[0]?.mimetype).toBe("text/plain; charset=EUC-JP");
	});

	// Two attachments, two encodings: they are told apart by walking the
	// declarations and the parser's list forward together.
	it("is read per attachment, not once for the message", async () => {
		await receive(
			message([
				...part(
					["Content-Type: text/plain; charset=Shift_JIS"],
					"first.txt",
					SHIFT_JIS,
				),
				...part(
					["Content-Type: text/plain; charset=EUC-JP"],
					"second.txt",
					SHIFT_JIS,
				),
			]),
		);
		const { list } = await attachments();
		expect(list.map((one) => `${one.filename}:${one.mimetype}`)).toEqual([
			"first.txt:text/plain; charset=Shift_JIS",
			"second.txt:text/plain; charset=EUC-JP",
		]);
	});

	/**
	 * A charset is a claim about text. Putting one on a PDF because the header
	 * happened to carry it would be inventing a fact about somebody's file, and
	 * the archive writer would then have to decide whether to believe it.
	 */
	it("is not invented for a file that is not text", async () => {
		await receive(
			message(
				part(
					["Content-Type: application/pdf; charset=Shift_JIS"],
					"report.pdf",
					SHIFT_JIS,
				),
			),
		);
		const { list } = await attachments();
		expect(list[0]?.mimetype).toBe("application/pdf");
	});

	/**
	 * And a semicolon inside a quoted filename is not a parameter. A sender
	 * who writes `name="report; charset=utf-8"` over a Shift_JIS part is
	 * describing a file called that, and believing it would relabel the file
	 * as the opposite of what it is.
	 */
	it("is not taken from inside a quoted filename", async () => {
		await receive(
			message(
				part(
					['Content-Type: text/plain; name="report; charset=utf-8"'],
					"note.txt",
					SHIFT_JIS,
				),
			),
		);
		const { list } = await attachments();
		expect(list[0]?.mimetype).toBe("text/plain");
	});

	// Nothing declared is nothing recorded: the row says what it always said.
	it("is left alone when the part declared none", async () => {
		await receive(
			message(part(["Content-Type: text/plain"], "note.txt", SHIFT_JIS)),
		);
		const { list } = await attachments();
		expect(list[0]?.mimetype).toBe("text/plain");
	});
});
