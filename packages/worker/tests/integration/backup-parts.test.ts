import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { PART_SIZE, PartBuffer, writeMailboxBackup } from "../../src/backup-writer";
import { authenticatedFetch, createDummyMailbox, mailboxId, testAuthBeforeAll } from "./utils";

/**
 * How the archive is cut into parts.
 *
 * R2 wants every part except the last to be at least 5 MiB *and* all of them
 * the same length. The writer only honoured the first half: it flushed
 * whenever the buffer happened to cross the threshold, so each part came out
 * 5 MiB plus whatever message tipped it over. One such part is fine -- with
 * two parts there is only one non-trailing part and nothing to disagree with.
 * From three parts on, `complete()` fails:
 *
 *   completeMultipartUpload: All non-trailing parts must have the same length.
 *
 * So every automatic backup of a mailbox past about 10 MiB failed, every
 * night, while smaller mailboxes succeeded and made the feature look sound.
 */

describe("cutting the archive into parts", () => {
	it("hands over exactly what was asked for", () => {
		const buffer = new PartBuffer();
		buffer.add(new Uint8Array([1, 2, 3]));
		buffer.add(new Uint8Array([4, 5, 6, 7]));

		expect([...buffer.take(5)]).toEqual([1, 2, 3, 4, 5]);
		expect(buffer.size).toBe(2);
		expect([...buffer.take(2)]).toEqual([6, 7]);
		expect(buffer.size).toBe(0);
	});

	// The heart of it: a message that straddles a boundary is split, so the
	// part is the size asked for rather than the size the message made it.
	it("splits a chunk that straddles the boundary", () => {
		const buffer = new PartBuffer();
		buffer.add(new Uint8Array([1, 2]));
		buffer.add(new Uint8Array([3, 4, 5, 6, 7, 8, 9]));

		expect([...buffer.take(4)]).toEqual([1, 2, 3, 4]);
		expect([...buffer.take(4)]).toEqual([5, 6, 7, 8]);
		expect([...buffer.take(4)]).toEqual([9]);
	});

	it("gives back everything when asked for more than it holds", () => {
		const buffer = new PartBuffer();
		buffer.add(new Uint8Array([1, 2, 3]));
		expect([...buffer.take(100)]).toEqual([1, 2, 3]);
		expect(buffer.size).toBe(0);
	});

	it("copes with being asked for nothing, and with an empty buffer", () => {
		const buffer = new PartBuffer();
		expect([...buffer.take(10)]).toEqual([]);
		buffer.add(new Uint8Array([1]));
		expect([...buffer.take(0)]).toEqual([]);
		expect(buffer.size).toBe(1);
	});

	/**
	 * The property that matters, stated as such: feed in messages of
	 * assorted awkward sizes, cut at a fixed width, and every part but the
	 * last must come out exactly that wide.
	 */
	it("makes every part but the last exactly one part wide", () => {
		const buffer = new PartBuffer();
		const sizes = [7, 3, 91, 1, 40, 12, 250, 5, 33];
		const width = 16;
		const parts: number[] = [];

		for (const size of sizes) {
			buffer.add(new Uint8Array(size));
			while (buffer.size >= width) parts.push(buffer.take(width).byteLength);
		}
		if (buffer.size > 0) parts.push(buffer.take(buffer.size).byteLength);

		const total = sizes.reduce((a, b) => a + b, 0);
		expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
		expect(parts.slice(0, -1).every((n) => n === width)).toBe(true);
		expect(parts.at(-1)).toBeLessThanOrEqual(width);
	});
});

/**
 * And the same thing against R2 itself. The pool's R2 enforces both rules --
 * verified, it answers 10048 for unequal non-trailing parts and refuses parts
 * under 5 MiB -- so this cannot be run with a smaller part size. It has to
 * move real megabytes.
 */
describe("a mailbox large enough to need three parts", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
	});

	it("is backed up rather than failing on complete()", async () => {
		// Twelve messages of about 1 MB: comfortably past two full parts, so
		// there are two non-trailing parts to disagree with each other. Their
		// sizes differ deliberately -- an uneven boundary is exactly what used
		// to make the parts differ.
		//
		// Many middling messages rather than a few huge ones because the
		// Durable Object's SQLite refuses a single value much over 2 MB
		// (SQLITE_TOOBIG), which is also how a real mailbox gets past 10 MB:
		// by accumulating, not by holding one enormous message.
		const MESSAGES = 12;
		for (let index = 0; index < MESSAGES; index++) {
			const res = await authenticatedFetch(
				`http://local.test/api/v1/mailboxes/${mailboxId}/emails`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						to: ["recipient@example.com"],
						from: mailboxId,
						subject: `Bulky ${index}`,
						text: "x".repeat(1_000_000 + index * 7_919),
					}),
				},
			);
			expect(res.status, `message ${index}`).toBe(201);
		}

		const result = await writeMailboxBackup(
			env as never,
			mailboxId,
			new Date("2026-09-01T18:00:00Z"),
			7,
		);

		expect(result.messages).toBe(MESSAGES);
		expect(result.bytes).toBeGreaterThan(2 * PART_SIZE);

		// The object is there, and its size is the whole archive: nothing was
		// dropped at a part boundary.
		const stored = await (env as unknown as { BUCKET: R2Bucket }).BUCKET.head(
			result.key,
		);
		expect(stored).not.toBeNull();
		expect(stored?.size).toBe(result.bytes);
	});
});
