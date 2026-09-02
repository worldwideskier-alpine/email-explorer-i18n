import { describe, expect, it } from "vitest";
import { type MboxEntry, parseMbox, toBase64 } from "./mbox";

/**
 * These fixtures are written the way the Worker's renderMboxEntry writes them
 * -- separator line, our X- headers, then the message -- so this is the other
 * half of the round trip, and the two halves have to agree on the format.
 *
 * Everything is built and compared as bytes, because that is the property that
 * broke: reading the file as text put U+FFFD wherever a message was not UTF-8,
 * and the tests, which only ever spoke in strings, could not tell.
 */

const enc = (text: string) => new TextEncoder().encode(text);
const dec = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

function bytes(...parts: (string | Uint8Array)[]): Uint8Array {
	const chunks = parts.map((part) =>
		typeof part === "string" ? enc(part) : part,
	);
	const out = new Uint8Array(
		chunks.reduce((sum, chunk) => sum + chunk.length, 0),
	);
	let at = 0;
	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.length;
	}
	return out;
}

function entry(
	headers: Record<string, string>,
	message: string | Uint8Array,
	sender = "a@example.com",
): Uint8Array {
	const ours = Object.entries(headers).map(
		([name, value]) => `X-Email-Explorer-${name}: ${value}`,
	);
	return bytes(
		`From ${sender} Sat Aug 01 10:00:00 2026\r\n${ours.join("\r\n")}\r\n`,
		message,
		"\r\n\r\n",
	);
}

const MESSAGE = "From: a@example.com\r\nSubject: Hello\r\n\r\nbody";

/** "日本語" in Shift_JIS. Valid mail, and not valid UTF-8. */
const SJIS = new Uint8Array([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]);

const raw = (parsed: MboxEntry) => dec(parsed.raw);

describe("parseMbox", () => {
	it("reads back what the export wrote", () => {
		const [parsed] = parseMbox(
			entry(
				{
					Id: "abc-123",
					Folder: "Sent",
					Read: "1",
					Starred: "1",
					Date: "2026-08-01T10:00:00.000Z",
				},
				MESSAGE,
			),
		);

		expect(parsed.id).toBe("abc-123");
		expect(parsed.folder).toBe("Sent");
		expect(parsed.read).toBe(true);
		expect(parsed.starred).toBe(true);
		expect(parsed.date).toBe("2026-08-01T10:00:00.000Z");
		expect(raw(parsed)).toBe(MESSAGE);
	});

	it("keeps our headers out of the message it hands back", () => {
		const [parsed] = parseMbox(entry({ Folder: "Inbox" }, MESSAGE));
		expect(raw(parsed)).not.toContain("X-Email-Explorer-");
	});

	it("separates messages", () => {
		const file = bytes(
			entry({ Id: "one", Folder: "Inbox" }, MESSAGE),
			entry({ Id: "two", Folder: "Sent" }, MESSAGE),
			entry({ Id: "three", Folder: "Trash" }, MESSAGE),
		);

		expect(parseMbox(file).map((e) => e.id)).toEqual(["one", "two", "three"]);
	});

	// The whole reason the writer escapes these: a body line that reads like a
	// separator would otherwise split one message into two.
	it("does not split on a quoted separator, and unquotes it", () => {
		const body =
			"From: a@example.com\r\nSubject: x\r\n\r\n>From here on\r\n>>From already quoted";
		const parsed = parseMbox(entry({ Folder: "Inbox" }, body));

		expect(parsed).toHaveLength(1);
		expect(raw(parsed[0])).toContain("\r\nFrom here on");
		expect(raw(parsed[0])).toContain("\r\n>From already quoted");
	});

	it("falls back to the inbox and to unflagged when a backup says nothing", () => {
		const [parsed] = parseMbox(
			bytes(
				`From a@example.com Sat Aug 01 10:00:00 2026\r\n${MESSAGE}\r\n\r\n`,
			),
		);
		expect(parsed.folder).toBe("inbox");
		expect(parsed.read).toBe(false);
		expect(parsed.starred).toBe(false);
		expect(parsed.id).toBeUndefined();
	});

	it("reads a file written with bare newlines", () => {
		const [parsed] = parseMbox(
			bytes(
				"From a@example.com Sat Aug 01 10:00:00 2026\nX-Email-Explorer-Folder: Sent\nFrom: a@example.com\nSubject: Hello\n\nbody\n",
			),
		);
		expect(parsed.folder).toBe("Sent");
		expect(raw(parsed)).toContain("Subject: Hello");
	});

	it("is empty for an empty file", () => {
		expect(parseMbox(bytes(""))).toEqual([]);
		expect(parseMbox(bytes("\r\n\r\n"))).toEqual([]);
	});

	// A header of this shape further down belongs to the message, not to us.
	it("only reads our headers from the top of the entry", () => {
		const body =
			"From: a@example.com\r\nSubject: x\r\n\r\nX-Email-Explorer-Folder: Trash";
		const [parsed] = parseMbox(entry({ Folder: "Inbox" }, body));

		expect(parsed.folder).toBe("Inbox");
		expect(raw(parsed)).toContain("X-Email-Explorer-Folder: Trash");
	});
});

/**
 * The defect this file exists to keep out.
 *
 * The restore read the archive with `file.text()` and everything downstream
 * spoke in strings, so a message that was not UTF-8 arrived with U+FFFD where
 * its bytes had been -- and then went back into the mailbox that way. There is
 * no recovering from it: the replacement character does not remember what it
 * replaced.
 */
describe("a message that is not UTF-8", () => {
	it("comes back with its bytes intact", () => {
		const message = bytes(
			'From: a@example.com\r\nSubject: x\r\nContent-Type: text/plain; charset="Shift_JIS"\r\n\r\n',
			SJIS,
		);
		const [parsed] = parseMbox(entry({ Folder: "Inbox" }, message));

		expect(Array.from(parsed.raw)).toEqual(Array.from(message));
		// The same thing said in the shape the failure took: U+FFFD is EF BF BD,
		// and the old code left one of them per byte it could not read. Asked of
		// the bytes, not of a decoding of them -- decoding Shift_JIS as UTF-8
		// here would produce the very characters this is looking for.
		expect(Array.from(parsed.raw).join(",")).not.toContain("239,191,189");
	});

	it("survives being handed to the import endpoint", () => {
		const [parsed] = parseMbox(entry({ Folder: "Inbox" }, SJIS));
		const decoded = Uint8Array.from(atob(toBase64(parsed.raw)), (ch) =>
			ch.charCodeAt(0),
		);
		expect(Array.from(decoded)).toEqual(Array.from(SJIS));
	});

	/**
	 * A byte that happens to be 0x0a or 0x3e inside a multi-byte character
	 * would be a real hazard for a byte scanner -- except that no mail encoding
	 * puts an ASCII byte in a trailing position, which is exactly why this is
	 * safe. Held here so the assumption is written down and checked.
	 */
	it("does not mistake a trailing byte for structure", () => {
		// Shift_JIS "ー" is 0x81 0x5b; 0x5b is ASCII "[", not a line feed or a
		// ">", and no lead byte is ever below 0x81.
		const tricky = new Uint8Array([0x81, 0x5b, 0x93, 0xfa]);
		const [parsed] = parseMbox(entry({ Folder: "Inbox" }, tricky));
		expect(Array.from(parsed.raw)).toEqual(Array.from(tricky));
	});
});

describe("what the writer padded, and only that", () => {
	/**
	 * The writer appends one blank line after every message. The old code
	 * stripped every trailing newline instead, which quietly ate blank lines a
	 * message genuinely ended with -- a small loss, but the same kind: content
	 * removed on the way through something that promised not to.
	 */
	it("keeps a blank line the message itself ended with", () => {
		const message = "From: a@example.com\r\nSubject: x\r\n\r\nbody\r\n\r\n";
		const [parsed] = parseMbox(entry({ Folder: "Inbox" }, message));
		expect(raw(parsed)).toBe(message);
	});
});

/**
 * The one line with no unit test of its own, and the one that decided the
 * whole thing: how the archive is read off disk. `file.text()` decodes as
 * UTF-8 before any of the code above ever sees a byte, so a parser that is
 * careful with bytes is worth nothing if the caller hands it a decoding.
 *
 * Read from the source, for the reason formContrast.test.ts documents: src/ is
 * type-checked without Node types, so there is no fs here.
 */
describe("how the restore screen reads the file", () => {
	const settings = Object.entries(
		import.meta.glob("../views/*.vue", {
			query: "?raw",
			import: "default",
			eager: true,
		}) as Record<string, string>,
	).find(([path]) => path.endsWith("Settings.vue"))?.[1];

	it("reads it as bytes, never as text", () => {
		expect(settings).toBeTruthy();
		expect(settings).toContain(
			"parseMbox(new Uint8Array(await file.arrayBuffer()))",
		);
		expect(settings).not.toContain("await file.text()");
	});
});

describe("toBase64", () => {
	// btoa alone throws on anything above U+00FF, which is most of the mail
	// this fork handles.
	it("encodes a message with non-Latin characters", () => {
		const message = enc("Subject: 請求書\r\n\r\n本文");
		const decoded = Uint8Array.from(atob(toBase64(message)), (ch) =>
			ch.charCodeAt(0),
		);
		expect(Array.from(decoded)).toEqual(Array.from(message));
	});

	it("encodes bytes that are not text at all", () => {
		const binary = new Uint8Array([0x00, 0x93, 0xfa, 0xff, 0x0a, 0x80]);
		const decoded = Uint8Array.from(atob(toBase64(binary)), (ch) =>
			ch.charCodeAt(0),
		);
		expect(Array.from(decoded)).toEqual(Array.from(binary));
	});
});
