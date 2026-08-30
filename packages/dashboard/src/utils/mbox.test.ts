import { describe, expect, it } from "vitest";
import { parseMbox, toBase64 } from "./mbox";

/**
 * These fixtures are written the way the Worker's renderMboxEntry writes them
 * -- separator line, our X- headers, then the message -- so this is the other
 * half of the round trip, and the two halves have to agree on the format.
 */

function entry(
	headers: Record<string, string>,
	message: string,
	sender = "a@example.com",
): string {
	const ours = Object.entries(headers).map(
		([name, value]) => `X-Email-Explorer-${name}: ${value}`,
	);
	return `From ${sender} Sat Aug 01 10:00:00 2026\r\n${ours.join("\r\n")}\r\n${message}\r\n\r\n`;
}

const MESSAGE = "From: a@example.com\r\nSubject: Hello\r\n\r\nbody";

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
		expect(parsed.raw).toBe(MESSAGE);
	});

	it("keeps our headers out of the message it hands back", () => {
		const [parsed] = parseMbox(entry({ Folder: "Inbox" }, MESSAGE));
		expect(parsed.raw).not.toContain("X-Email-Explorer-");
	});

	it("separates messages", () => {
		const file =
			entry({ Id: "one", Folder: "Inbox" }, MESSAGE) +
			entry({ Id: "two", Folder: "Sent" }, MESSAGE) +
			entry({ Id: "three", Folder: "Trash" }, MESSAGE);

		expect(parseMbox(file).map((e) => e.id)).toEqual(["one", "two", "three"]);
	});

	// The whole reason the writer escapes these: a body line that reads like a
	// separator would otherwise split one message into two.
	it("does not split on a quoted separator, and unquotes it", () => {
		const body =
			"From: a@example.com\r\nSubject: x\r\n\r\n>From here on\r\n>>From already quoted";
		const parsed = parseMbox(entry({ Folder: "Inbox" }, body));

		expect(parsed).toHaveLength(1);
		expect(parsed[0].raw).toContain("\r\nFrom here on");
		expect(parsed[0].raw).toContain("\r\n>From already quoted");
	});

	it("falls back to the inbox and to unflagged when a backup says nothing", () => {
		const [parsed] = parseMbox(
			`From a@example.com Sat Aug 01 10:00:00 2026\r\n${MESSAGE}\r\n\r\n`,
		);
		expect(parsed.folder).toBe("inbox");
		expect(parsed.read).toBe(false);
		expect(parsed.starred).toBe(false);
		expect(parsed.id).toBeUndefined();
	});

	it("reads a file written with bare newlines", () => {
		const file = `From a@example.com Sat Aug 01 10:00:00 2026\nX-Email-Explorer-Folder: Sent\nFrom: a@example.com\nSubject: Hello\n\nbody\n`;
		const [parsed] = parseMbox(file);
		expect(parsed.folder).toBe("Sent");
		expect(parsed.raw).toContain("Subject: Hello");
	});

	it("is empty for an empty file", () => {
		expect(parseMbox("")).toEqual([]);
		expect(parseMbox("\r\n\r\n")).toEqual([]);
	});

	// A header of this shape further down belongs to the message, not to us.
	it("only reads our headers from the top of the entry", () => {
		const body = `From: a@example.com\r\nSubject: x\r\n\r\nX-Email-Explorer-Folder: Trash`;
		const [parsed] = parseMbox(entry({ Folder: "Inbox" }, body));

		expect(parsed.folder).toBe("Inbox");
		expect(parsed.raw).toContain("X-Email-Explorer-Folder: Trash");
	});
});

describe("toBase64", () => {
	// btoa alone throws on anything above U+00FF, which is most of the mail
	// this fork handles.
	it("encodes a message with non-Latin characters", () => {
		const encoded = toBase64("Subject: 請求書\r\n\r\n本文");
		expect(atob(encoded)).toBe(
			Array.from(new TextEncoder().encode("Subject: 請求書\r\n\r\n本文"))
				.map((b) => String.fromCharCode(b))
				.join(""),
		);
	});
});
