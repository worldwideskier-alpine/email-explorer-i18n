import { describe, expect, it } from "vitest";
import type { ExportedEmail } from "../../src/mbox";
import { renderMboxEntry } from "../../src/mbox";
import type { Env } from "../../src/types";

/**
 * The export had no test, and that is how it shipped writing every message as
 * an unread, unstarred message in the inbox: mbox.ts read `email.folder`,
 * while the row the Durable Object hands it calls that column `folder_id`.
 * Nothing failed -- the file was still a valid mbox, just a lying one.
 *
 * The second thing it shipped is why these fixtures are bytes. The raw copy
 * was read with `.text()`, which decodes as UTF-8, so a message that is not --
 * 8-bit Shift_JIS, EUC-JP, most of what is not English -- was written into the
 * archive with U+FFFD where its bytes had been. The old tests could not see it
 * because they only ever spoke in strings.
 */

const enc = (text: string) => new TextEncoder().encode(text);
const dec = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** Only BUCKET.get is reached; a raw copy is what separates the two paths. */
function envWith(raw: Record<string, string | Uint8Array>): Env {
	return {
		BUCKET: {
			get: async (key: string) => {
				if (!(key in raw)) return null;
				const value = raw[key];
				const bytes = typeof value === "string" ? enc(value) : value;
				return {
					arrayBuffer: async () =>
						bytes.buffer.slice(
							bytes.byteOffset,
							bytes.byteOffset + bytes.byteLength,
						),
				};
			},
		},
	} as unknown as Env;
}

const ROW: ExportedEmail = {
	id: "abc-123",
	folder_id: "sent",
	subject: "Hello",
	sender: "a@example.com",
	recipient: "b@example.com",
	date: "2026-08-01T10:00:00.000Z",
	read: true,
	starred: true,
	body: "<p>hi</p>",
};

const RAW_KEY = `raw/${ROW.id}.eml`;
const RAW = "From: a@example.com\r\nSubject: Hello\r\n\r\nhi";

/** "日本語" in Shift_JIS. Valid mail, and not valid UTF-8. */
const SJIS = new Uint8Array([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]);

const text = async (...args: Parameters<typeof renderMboxEntry>) =>
	dec(await renderMboxEntry(...args));

describe("renderMboxEntry", () => {
	it("records the folder the message actually sat in", async () => {
		const entry = await text(envWith({}), ROW, "Sent");
		expect(entry).toContain("X-Email-Explorer-Folder: Sent");
		expect(entry).not.toContain("X-Email-Explorer-Folder: inbox");
	});

	it("records read and starred", async () => {
		const on = await text(envWith({}), ROW, "Sent");
		expect(on).toContain("X-Email-Explorer-Read: 1");
		expect(on).toContain("X-Email-Explorer-Starred: 1");

		const off = await text(
			envWith({}),
			{ ...ROW, read: false, starred: false },
			"Inbox",
		);
		expect(off).toContain("X-Email-Explorer-Read: 0");
		expect(off).toContain("X-Email-Explorer-Starred: 0");
	});

	it("records the id and the date the mailbox stored", async () => {
		const entry = await text(envWith({}), ROW, "Sent");
		expect(entry).toContain("X-Email-Explorer-Id: abc-123");
		expect(entry).toContain("X-Email-Explorer-Date: 2026-08-01T10:00:00.000Z");
	});

	// A folder name is the one field here the user writes, so it is the one
	// that could end the header early and splice text into the message.
	it("keeps a newline in a folder name out of the headers", async () => {
		const entry = await text(envWith({}), ROW, "Odd\r\nX-Injected: yes");
		// It survives as text inside the folder header, never as a header of
		// its own, which is what a line of its own would have made it.
		expect(/^X-Injected:/m.test(entry)).toBe(false);
		expect(entry).toContain("X-Email-Explorer-Folder: Odd X-Injected: yes");
	});

	it("writes received mail back from its raw copy, byte for byte", async () => {
		const entry = await text(envWith({ [RAW_KEY]: RAW }), ROW, "Inbox");
		expect(entry).toContain(RAW);
		// The synthesized form would carry these; the raw copy does not.
		expect(entry).not.toContain("MIME-Version: 1.0");
	});

	it("rebuilds composed mail when there is no raw copy", async () => {
		const entry = await text(envWith({}), ROW, "Sent");
		expect(entry).toContain("MIME-Version: 1.0");
		expect(entry).toContain("<p>hi</p>");
	});

	it("starts the entry with an mbox separator line", async () => {
		const entry = await text(envWith({}), ROW, "Sent");
		expect(entry.startsWith("From a@example.com ")).toBe(true);
	});

	// mboxrd: a body line that reads like a separator has to be quoted, or the
	// file splits in the wrong place when it is read back.
	it("quotes body lines that look like a separator", async () => {
		const entry = await text(
			envWith({ [RAW_KEY]: "Subject: x\r\n\r\nFrom nowhere\r\n>From nowhere" }),
			ROW,
			"Inbox",
		);
		expect(entry).toContain(">From nowhere");
		expect(entry).toContain(">>From nowhere");
	});

	it("quotes one at the very start of the message too", async () => {
		const entry = await text(
			envWith({ [RAW_KEY]: "From nowhere\r\nSubject: x" }),
			ROW,
			"Inbox",
		);
		// The separator line the writer put on, then the quoted one -- never
		// two lines that both read as separators.
		expect(entry).toContain("\r\n>From nowhere\r\n");
	});
});

/**
 * The defect this file exists to keep out.
 *
 * Deleting a message removes its raw copy from R2, and the nightly spam purge
 * deletes messages. For anything deleted, the archive is the only copy that
 * remains -- so a lossy archive is not an inconvenience, it is the loss.
 */
describe("a message that is not UTF-8", () => {
	const message = () =>
		new Uint8Array([
			...enc(
				'From: a@example.com\r\nSubject: x\r\nContent-Type: text/plain; charset="Shift_JIS"\r\n\r\n',
			),
			...SJIS,
		]);

	it("is written into the archive byte for byte", async () => {
		const entry = await renderMboxEntry(
			envWith({ [RAW_KEY]: message() }),
			ROW,
			"Inbox",
		);

		const haystack = Array.from(entry).join(",");
		expect(haystack).toContain(Array.from(SJIS).join(","));
	});

	it("puts no replacement character anywhere in the archive", async () => {
		const entry = await renderMboxEntry(
			envWith({ [RAW_KEY]: message() }),
			ROW,
			"Inbox",
		);
		// U+FFFD is EF BF BD in UTF-8; the old code produced one per lost byte.
		// Asked of the bytes, not of a decoding of them -- decoding Shift_JIS as
		// UTF-8 here would produce the very characters this is looking for.
		expect(Array.from(entry).join(",")).not.toContain("239,191,189");
	});

	/**
	 * The archive is bytes, so its length is the message's length plus exactly
	 * what the writer adds. Under the old code a six-byte Shift_JIS body became
	 * five replacement characters -- fifteen bytes -- and the length was the
	 * first thing that gave it away.
	 */
	it("does not change the message's length on the way through", async () => {
		const raw = message();
		const entry = await renderMboxEntry(
			envWith({ [RAW_KEY]: raw }),
			ROW,
			"Inbox",
		);
		const header = enc(
			`From a@example.com Sat Aug 01 10:00:00 2026\r\nX-Email-Explorer-Id: ${ROW.id}\r\nX-Email-Explorer-Folder: Inbox\r\nX-Email-Explorer-Read: 1\r\nX-Email-Explorer-Starred: 1\r\nX-Email-Explorer-Date: ${ROW.date}\r\n`,
		);
		expect(entry.length).toBe(header.length + raw.length + 2 /* \r\n */ + 2);
	});

	/**
	 * The byte scan compares against ASCII only, and no multi-byte mail
	 * encoding puts an ASCII byte in a trailing position. That is what makes
	 * scanning bytes safe whatever the message turns out to be; held here so
	 * the assumption is written down and checked.
	 */
	it("does not mistake a trailing byte for structure", async () => {
		// Shift_JIS "ー" is 0x81 0x5b -- 0x5b is ASCII "[", not LF and not ">".
		const tricky = new Uint8Array([0x81, 0x5b, 0x93, 0xfa]);
		const entry = await renderMboxEntry(
			envWith({ [RAW_KEY]: tricky }),
			ROW,
			"Inbox",
		);
		expect(Array.from(entry).join(",")).toContain(Array.from(tricky).join(","));
	});
});
