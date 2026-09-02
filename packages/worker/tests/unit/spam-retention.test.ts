import { describe, expect, it } from "vitest";
import {
	DEFAULT_SPAM_RETENTION_DAYS,
	expiredSpamIds,
	MAX_SPAM_RETENTION_DAYS,
	MIN_SPAM_RETENTION_DAYS,
	normalizeRetentionDays,
	retentionCutoff,
} from "../../src/spam-retention";

/**
 * Which messages the scheduled purge is allowed to delete.
 *
 * This is the only judgement in the feature, and the deletion it leads to is
 * permanent, so every way it could pick the wrong message is worth an
 * assertion of its own.
 */

const NOW = Date.parse("2026-09-01T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

describe("the retention setting", () => {
	it("keeps a sensible number as it is", () => {
		expect(normalizeRetentionDays(30)).toBe(30);
		expect(normalizeRetentionDays("14")).toBe(14);
	});

	/**
	 * Zero would mean "delete everything in the spam folder every night",
	 * which is not a retention policy: it loses a message misfiled that
	 * morning before anyone has been at their desk.
	 */
	it("will not go below a day, however it is asked", () => {
		expect(normalizeRetentionDays(0)).toBe(MIN_SPAM_RETENTION_DAYS);
		expect(normalizeRetentionDays(-90)).toBe(MIN_SPAM_RETENTION_DAYS);
	});

	it("will not go above a year", () => {
		expect(normalizeRetentionDays(100000)).toBe(MAX_SPAM_RETENTION_DAYS);
	});

	/**
	 * Anything unreadable falls back to the default rather than to the floor.
	 *
	 * The tempting implementation clamps whatever `Number()` returns, and
	 * `Number(null)`, `Number("")` and `Number([])` are all 0 -- so a cleared
	 * number field in the browser, or a stored setting with no days in it,
	 * would come out as one day and delete a month of the spam folder on the
	 * next run. Each of these is a value that actually reaches here.
	 */
	it("falls back to the default when it cannot read the value", () => {
		for (const value of [
			undefined,
			null,
			"",
			"   ",
			"soon",
			Number.NaN,
			{},
			[],
			true,
		]) {
			expect(
				normalizeRetentionDays(value),
				`for ${JSON.stringify(value) ?? "undefined"}`,
			).toBe(DEFAULT_SPAM_RETENTION_DAYS);
		}
	});

	it("truncates rather than rounding up", () => {
		expect(normalizeRetentionDays(7.9)).toBe(7);
	});
});

describe("the cutoff", () => {
	it("is the given number of days before now", () => {
		expect(retentionCutoff(30, NOW)).toBe(NOW - 30 * DAY);
	});

	it("is computed from the clamped setting, not the raw one", () => {
		expect(retentionCutoff(0, NOW)).toBe(NOW - MIN_SPAM_RETENTION_DAYS * DAY);
	});
});

describe("choosing what to delete", () => {
	const cutoff = retentionCutoff(30, NOW);

	it("takes what is older than the cutoff and leaves the rest", () => {
		expect(
			expiredSpamIds(
				[
					{ id: "old", date: "2026-07-01T00:00:00.000Z" },
					{ id: "recent", date: "2026-08-30T00:00:00.000Z" },
				],
				cutoff,
			),
		).toEqual(["old"]);
	});

	// Exactly at the cutoff is not past it. A boundary that deletes is one
	// day's mail different from a boundary that does not, in the direction
	// that cannot be undone.
	it("leaves a message sitting exactly on the cutoff", () => {
		expect(
			expiredSpamIds(
				[{ id: "edge", date: new Date(cutoff).toISOString() }],
				cutoff,
			),
		).toEqual([]);
	});

	/**
	 * The reason the dates are parsed rather than compared as text. An
	 * imported message carries its own Date header, which may be written with
	 * an offset -- and "2026-08-31T09:00:00+09:00" sorts before every ISO-UTC
	 * timestamp of that morning while being the same moment as midnight UTC.
	 */
	it("reads an offset date as the moment it is, not as the text it is", () => {
		// 2026-07-01T09:00+09:00 is 2026-07-01T00:00Z -- old either way, so
		// the interesting one is the near side: 2026-08-30T09:00+09:00 is
		// still well inside the window and must survive.
		expect(
			expiredSpamIds(
				[
					{ id: "kept", date: "2026-08-30T09:00:00+09:00" },
					{ id: "gone", date: "2026-07-01T09:00:00+09:00" },
				],
				cutoff,
			),
		).toEqual(["gone"]);
	});

	it("understands the other date formats a mail header carries", () => {
		expect(
			expiredSpamIds(
				[{ id: "rfc", date: "Wed, 01 Jul 2026 00:00:00 +0000" }],
				cutoff,
			),
		).toEqual(["rfc"]);
	});

	/**
	 * The rule that decides the whole design: nothing is deleted on a guess.
	 * A message with no date, or with one that cannot be read, is kept -- for
	 * ever, if need be. That costs storage. Treating it as infinitely old
	 * would cost mail.
	 */
	it("keeps anything whose date it cannot read", () => {
		expect(
			expiredSpamIds(
				[
					{ id: "none", date: null },
					{ id: "empty", date: "" },
					{ id: "nonsense", date: "last Tuesday-ish" },
				],
				cutoff,
			),
		).toEqual([]);
	});

	it("has nothing to say about an empty folder", () => {
		expect(expiredSpamIds([], cutoff)).toEqual([]);
	});
});
