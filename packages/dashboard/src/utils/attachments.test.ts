import { describe, expect, it } from "vitest";
import {
	bytesToBase64,
	fileToAttachment,
	formatBytes,
	MAX_TOTAL_ATTACHMENT_BYTES,
	totalAttachmentBytes,
} from "./attachments";

/**
 * Reading a picked file into what the send API takes.
 *
 * The encoding is the part worth testing rather than trusting. A file is
 * bytes, and every step that treats it as text instead loses the bytes above
 * 0x7F -- which is what happened on the Worker side, where attachments were
 * stored through a UTF-8 encode and every binary file came back corrupt. The
 * same mistake made here would be just as quiet: an ASCII file would look
 * perfect right up until somebody attached a photograph.
 */

const decode = (base64: string): number[] =>
	Array.from(atob(base64), (ch) => ch.charCodeAt(0));

describe("bytesToBase64", () => {
	it("round-trips every byte value", () => {
		const all = new Uint8Array(256);
		for (let i = 0; i < 256; i++) all[i] = i;
		expect(decode(bytesToBase64(all))).toEqual(Array.from(all));
	});

	it("handles the empty file", () => {
		expect(bytesToBase64(new Uint8Array(0))).toBe("");
	});

	/**
	 * The chunking is what lets this work on a file anyone would actually
	 * attach: `String.fromCharCode(...bytes)` spreads every byte into an
	 * argument list, and past roughly 130,000 arguments that overflows the
	 * stack -- measured, in this Node.
	 *
	 * One megabyte is used rather than something just past the 32KB chunk
	 * boundary. The first version of this test used 96KB, which is under the
	 * real threshold: it passed with the chunking removed and so proved
	 * nothing. A size well inside what the limit permits, and well past where
	 * the naive version dies, is the only one worth asserting on.
	 */
	it("encodes a file far past what an argument list can carry", () => {
		const big = new Uint8Array(1024 * 1024);
		for (let i = 0; i < big.length; i++) big[i] = i % 256;

		const decoded = decode(bytesToBase64(big));
		expect(decoded).toHaveLength(big.length);
		expect(decoded[0]).toBe(0);
		// Either side of a chunk boundary, where an off-by-one would land.
		expect(decoded[0x8000 - 1]).toBe((0x8000 - 1) % 256);
		expect(decoded[0x8000]).toBe(0x8000 % 256);
		expect(decoded.at(-1)).toBe((big.length - 1) % 256);
	});
});

describe("fileToAttachment", () => {
	it("carries the bytes, the name and the type", async () => {
		const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]);
		const file = new File([bytes], "picture.png", { type: "image/png" });

		const att = await fileToAttachment(file);
		expect(att.filename).toBe("picture.png");
		expect(att.type).toBe("image/png");
		expect(att.size).toBe(bytes.length);
		expect(decode(att.content)).toEqual(Array.from(bytes));
	});

	// A browser leaves the type empty for an extension it does not recognise,
	// and the API will not take an empty one.
	it("names a type when the browser gives none", async () => {
		const att = await fileToAttachment(new File([new Uint8Array([1])], "x.q"));
		expect(att.type).toBe("application/octet-stream");
	});

	it("gives each pick its own id, so the same file twice can be told apart", async () => {
		const make = () => new File([new Uint8Array([1])], "same.txt");
		const [a, b] = await Promise.all([
			fileToAttachment(make()),
			fileToAttachment(make()),
		]);
		expect(a.id).not.toBe(b.id);
	});
});

describe("the limit", () => {
	it("adds up what is attached", () => {
		expect(totalAttachmentBytes([])).toBe(0);
		expect(totalAttachmentBytes([{ size: 10 }, { size: 32 }])).toBe(42);
	});

	// Named rather than pinned to a number: what matters is that it leaves
	// room inside Resend's 40MB once base64 has made it a third larger.
	it("leaves room for the encoded copy inside what Resend accepts", () => {
		const encoded = MAX_TOTAL_ATTACHMENT_BYTES * (4 / 3);
		expect(encoded).toBeLessThan(40 * 1024 * 1024);
		expect(MAX_TOTAL_ATTACHMENT_BYTES).toBeGreaterThan(5 * 1024 * 1024);
	});
});

describe("formatBytes", () => {
	it("says something a person can read", () => {
		expect(formatBytes(0)).toBe("0 B");
		expect(formatBytes(512)).toBe("512 B");
		expect(formatBytes(2048)).toBe("2 KB");
		expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
	});
});
