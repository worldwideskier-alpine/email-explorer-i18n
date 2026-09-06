import { describe, expect, it } from "vitest";
import { renderBatches, renderCost } from "../../src/backup-writer";

/**
 * How much of a page is built at the same time.
 *
 * The renders were made concurrent to stop the nightly run being killed for
 * taking too long, and a count alone put the same kill back from the other
 * side. Twelve ordinary messages are nothing; twelve twenty-megabyte ones are
 * built at once, and each render holds the source, the escaped copy and the
 * joined copy together. Over the isolate's limit there is no exception to
 * catch -- the invocation stops, records nothing, and looks exactly like the
 * fault this all began with, on the mailboxes a backup matters most for.
 *
 * The tests below are on the split rather than on a real backup because the
 * sizes that matter cannot be put through one: a fixture of twelve
 * twenty-megabyte messages is not a test anybody would wait for, and the
 * mailbox that would prove it is the customer's.
 */

const MB = 1024 * 1024;

/** A message with attachments of a given total size, and a short body. */
const mail = (attachedBytes: number, id = "m") => ({
	id,
	body: "<p>hello</p>",
	attachments: attachedBytes ? [{ id: `${id}-a`, size: attachedBytes }] : [],
});

const sizes = (batches: { id: string }[][]) => batches.map((b) => b.length);
const flat = (batches: { id: string }[][]) =>
	batches.flat().map((one) => one.id);

describe("what a message costs before it is rendered", () => {
	// Attachments are the only term that moves by orders of magnitude.
	it("grows with the attachments, base64 and all", () => {
		expect(renderCost(mail(0))).toBeLessThan(100 * 1024);
		expect(renderCost(mail(3 * MB))).toBeGreaterThan(4 * MB);
	});

	/**
	 * A body is measured in bytes, not in the units a string is counted in.
	 *
	 * `String.length` is UTF-16 code units. Every character of a Japanese body
	 * is one unit and three bytes, so the cost came out at a third of the truth
	 * and three times as many of them fitted the budget -- on exactly the mail
	 * this deployment carries.
	 */
	it("costs a Japanese body at what it weighs", () => {
		const ascii = { body: "a".repeat(30_000), attachments: [] };
		const kanji = { body: "あ".repeat(30_000), attachments: [] };

		expect(renderCost(kanji) - renderCost(ascii)).toBe(60_000);
		// And a character outside the basic plane is four bytes, not six: it is
		// two code units, and counting per unit would double it.
		const emoji = { body: "😀".repeat(10_000), attachments: [] };
		expect(renderCost(emoji) - 64 * 1024).toBe(40_000);
	});

	// The row is the customer's data and none of it is ours to trust.
	it("reads nonsense sizes as nothing rather than as NaN", () => {
		for (const size of [undefined, null, "", "big", Number.NaN, -1, [], {}]) {
			const cost = renderCost({ attachments: [{ size }] });
			expect(Number.isFinite(cost)).toBe(true);
			expect(cost).toBeGreaterThan(0);
		}
		expect(renderCost({})).toBeGreaterThan(0);
		expect(renderCost({ attachments: [] })).toBeGreaterThan(0);
	});
});

describe("splitting a page into what may be built at once", () => {
	// Ordinary mail: the count is what binds, and it is the whole point.
	it("groups small messages up to the count", () => {
		const page = Array.from({ length: 30 }, (_, n) => mail(0, `m${n}`));
		expect(sizes(renderBatches(page))).toEqual([12, 12, 6]);
	});

	/**
	 * And large ones by their size instead. Nine megabytes apiece is twenty-one
	 * once the base64 copy is counted: one fits the budget and two do not, so
	 * they go one at a time although the count would allow twelve.
	 *
	 * Nine and not fifteen: fifteen is over the budget on its own, which makes
	 * this the oversized-message case the test below already covers rather
	 * than the bytes-beating-the-count case it is here for.
	 */
	it("splits on the bytes before the count", () => {
		const page = Array.from({ length: 6 }, (_, n) => mail(9 * MB, `m${n}`));
		expect(renderCost(mail(9 * MB))).toBeLessThan(24 * MB);
		expect(sizes(renderBatches(page))).toEqual([1, 1, 1, 1, 1, 1]);
	});

	it("fits what it can inside the budget", () => {
		const page = Array.from({ length: 6 }, (_, n) => mail(5 * MB, `m${n}`));
		// Just under twelve megabytes each once the base64 copy is counted: two
		// fit in twenty-four, three do not, and the split is on the bytes rather
		// than on the count of twelve.
		expect(sizes(renderBatches(page))).toEqual([2, 2, 2]);
	});

	/**
	 * A message bigger than the whole budget still gets rendered. Alone, which
	 * is what the serial loop did with every message -- refusing to back it up
	 * is not one of the options.
	 */
	it("gives an oversized message a batch of its own", () => {
		const page = [mail(0, "a"), mail(40 * MB, "huge"), mail(0, "b")];
		expect(sizes(renderBatches(page))).toEqual([1, 1, 1]);
		expect(flat(renderBatches(page))).toEqual(["a", "huge", "b"]);
	});

	// Whatever the split, the page comes out whole and in order: the archive is
	// written in date order and a lost or moved message is invisible until
	// somebody restores from it.
	it("keeps every message, once, in order", () => {
		const page = [
			mail(0, "a"),
			mail(7 * MB, "b"),
			mail(0, "c"),
			mail(0, "d"),
			mail(30 * MB, "e"),
			mail(0, "f"),
		];
		expect(flat(renderBatches(page))).toEqual(["a", "b", "c", "d", "e", "f"]);
	});

	it("has nothing to do with an empty page", () => {
		expect(renderBatches([])).toEqual([]);
	});
});
