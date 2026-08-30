import { describe, expect, it } from "vitest";
import type { ExportedEmail } from "../../src/mbox";
import { renderMboxEntry } from "../../src/mbox";
import type { Env } from "../../src/types";

/**
 * The export had no test, and that is how it shipped writing every message as
 * an unread, unstarred message in the inbox: mbox.ts read `email.folder`,
 * while the row the Durable Object hands it calls that column `folder_id`.
 * Nothing failed -- the file was still a valid mbox, just a lying one.
 */

/** Only BUCKET.get is reached; a raw copy is what separates the two paths. */
function envWith(raw: Record<string, string>): Env {
	return {
		BUCKET: {
			get: async (key: string) =>
				key in raw ? { text: async () => raw[key] } : null,
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

describe("renderMboxEntry", () => {
	it("records the folder the message actually sat in", async () => {
		const entry = await renderMboxEntry(envWith({}), ROW, "Sent");
		expect(entry).toContain("X-Email-Explorer-Folder: Sent");
		expect(entry).not.toContain("X-Email-Explorer-Folder: inbox");
	});

	it("records read and starred", async () => {
		const on = await renderMboxEntry(envWith({}), ROW, "Sent");
		expect(on).toContain("X-Email-Explorer-Read: 1");
		expect(on).toContain("X-Email-Explorer-Starred: 1");

		const off = await renderMboxEntry(
			envWith({}),
			{ ...ROW, read: false, starred: false },
			"Inbox",
		);
		expect(off).toContain("X-Email-Explorer-Read: 0");
		expect(off).toContain("X-Email-Explorer-Starred: 0");
	});

	it("records the id and the date the mailbox stored", async () => {
		const entry = await renderMboxEntry(envWith({}), ROW, "Sent");
		expect(entry).toContain("X-Email-Explorer-Id: abc-123");
		expect(entry).toContain(
			"X-Email-Explorer-Date: 2026-08-01T10:00:00.000Z",
		);
	});

	// A folder name is the one field here the user writes, so it is the one
	// that could end the header early and splice text into the message.
	it("keeps a newline in a folder name out of the headers", async () => {
		const entry = await renderMboxEntry(
			envWith({}),
			ROW,
			"Odd\r\nX-Injected: yes",
		);
		// It survives as text inside the folder header, never as a header of
		// its own, which is what a line of its own would have made it.
		expect(/^X-Injected:/m.test(entry)).toBe(false);
		expect(entry).toContain("X-Email-Explorer-Folder: Odd X-Injected: yes");
	});

	it("writes received mail back from its raw copy, byte for byte", async () => {
		const entry = await renderMboxEntry(envWith({ [RAW_KEY]: RAW }), ROW, "Inbox");
		expect(entry).toContain(RAW);
		// The synthesized form would carry these; the raw copy does not.
		expect(entry).not.toContain("MIME-Version: 1.0");
	});

	it("rebuilds composed mail when there is no raw copy", async () => {
		const entry = await renderMboxEntry(envWith({}), ROW, "Sent");
		expect(entry).toContain("MIME-Version: 1.0");
		expect(entry).toContain("<p>hi</p>");
	});

	it("starts the entry with an mbox separator line", async () => {
		const entry = await renderMboxEntry(envWith({}), ROW, "Sent");
		expect(entry.startsWith("From a@example.com ")).toBe(true);
	});

	// mboxrd: a body line that reads like a separator has to be quoted, or the
	// file splits in the wrong place when it is read back.
	it("quotes body lines that look like a separator", async () => {
		const entry = await renderMboxEntry(
			envWith({ [RAW_KEY]: "Subject: x\r\n\r\nFrom nowhere\r\n>From nowhere" }),
			ROW,
			"Inbox",
		);
		expect(entry).toContain(">From nowhere");
		expect(entry).toContain(">>From nowhere");
	});
});
