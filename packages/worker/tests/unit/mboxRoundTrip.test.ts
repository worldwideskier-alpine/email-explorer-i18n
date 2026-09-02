import { describe, expect, it } from "vitest";
// The dashboard's reader, imported directly. It is plain TypeScript over
// TextEncoder/TextDecoder and nothing else, so the two halves of the round
// trip can be put in front of each other here rather than tested apart and
// hoped about. This direction and not the other: the dashboard's own type
// check runs without Cloudflare's types, so importing the Worker there breaks
// the build, while the Worker's has everything both files need.
import { parseMbox } from "../../../dashboard/src/utils/mbox";
import { renderMboxEntry } from "../../src/mbox";
import type { Env } from "../../src/types";

/**
 * Export, then restore: the same message, the same bytes.
 *
 * Both halves had the same defect, and each was enough on its own to destroy a
 * message. The writer read the raw copy with `.text()`; the reader read the
 * file with `file.text()`. Neither is a decision a message survives if it is
 * not UTF-8 -- and plenty of Japanese mail is 8-bit Shift_JIS or EUC-JP, which
 * is not.
 *
 * So the property worth holding is not "the writer keeps the bytes" or "the
 * reader keeps the bytes", which are each half an answer: it is that a message
 * put in one end comes out of the other unchanged. Fixing one side and testing
 * only that side would have left the archive readable and the restore still
 * destroying what it read.
 */

const enc = (text: string) => new TextEncoder().encode(text);

function envWith(raw: Uint8Array): Env {
	return {
		BUCKET: {
			get: async () => ({
				arrayBuffer: async () =>
					raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
			}),
		},
	} as unknown as Env;
}

const ROW = {
	id: "round-trip-1",
	folder_id: "inbox",
	sender: "sender@example.com",
	date: "2026-09-02T00:00:00.000Z",
	read: true,
	starred: false,
};

async function roundTrip(message: Uint8Array) {
	const archive = await renderMboxEntry(envWith(message), ROW, "Spam");
	const [restored] = parseMbox(archive);
	return restored;
}

describe("a message put through the archive and back", () => {
	it("keeps 8-bit Shift_JIS exactly", async () => {
		const message = new Uint8Array([
			...enc(
				'From: sender@example.com\r\nSubject: x\r\nContent-Type: text/plain; charset="Shift_JIS"\r\nContent-Transfer-Encoding: 8bit\r\n\r\n',
			),
			// 日本語
			0x93,
			0xfa,
			0x96,
			0x7b,
			0x8c,
			0xea,
		]);

		const restored = await roundTrip(message);
		expect(Array.from(restored.raw)).toEqual(Array.from(message));
	});

	// The escaping exists for exactly this, and it has to survive being put on
	// and taken off again -- on bytes now, at both ends.
	it("keeps a body line that reads like a separator", async () => {
		const message = enc(
			"From: sender@example.com\r\nSubject: x\r\n\r\nFrom nowhere\r\n>From nowhere\r\n>>From nowhere",
		);
		const restored = await roundTrip(message);
		expect(Array.from(restored.raw)).toEqual(Array.from(message));
	});

	it("keeps a blank line the message itself ended with", async () => {
		const message = enc(
			"From: sender@example.com\r\nSubject: x\r\n\r\nbody\r\n\r\n",
		);
		const restored = await roundTrip(message);
		expect(Array.from(restored.raw)).toEqual(Array.from(message));
	});

	it("keeps bytes that are not text in any encoding", async () => {
		const message = new Uint8Array([
			...enc("From: sender@example.com\r\nSubject: x\r\n\r\n"),
			0x00,
			0xff,
			0x80,
			0xfe,
			0x93,
			0xfa,
		]);
		const restored = await roundTrip(message);
		expect(Array.from(restored.raw)).toEqual(Array.from(message));
	});

	// The folder is why the archive is worth restoring rather than just
	// reading: a message goes back where it was.
	it("carries the folder, read and starred across", async () => {
		const restored = await roundTrip(enc("Subject: x\r\n\r\nbody"));
		expect(restored.folder).toBe("Spam");
		expect(restored.read).toBe(true);
		expect(restored.starred).toBe(false);
		expect(restored.id).toBe(ROW.id);
		expect(restored.date).toBe(ROW.date);
	});
});
