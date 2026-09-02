import { describe, expect, it } from "vitest";
import {
	backupKey,
	backupKeyPrefix,
	isBackupDue,
	keysToRotate,
	normalizeFrequency,
	normalizeKeep,
} from "../../src/auto-backup";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-09-01T03:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("isBackupDue", () => {
	it("says no when the mailbox has not turned it on", () => {
		expect(isBackupDue(undefined, NOW)).toBe(false);
		expect(isBackupDue({}, NOW)).toBe(false);
		expect(
			isBackupDue({ enabled: false, frequency: "daily", keep: 7 }, NOW),
		).toBe(false);
	});

	// Otherwise switching it on means waiting a month to find out it works.
	it("says yes the first time, whatever the frequency", () => {
		for (const frequency of ["daily", "weekly", "monthly"] as const) {
			expect(isBackupDue({ enabled: true, frequency, keep: 7 }, NOW)).toBe(
				true,
			);
		}
	});

	it("waits out the interval", () => {
		const daily = { enabled: true, frequency: "daily" as const, keep: 7 };
		expect(isBackupDue({ ...daily, lastRunAt: ago(2 * HOUR) }, NOW)).toBe(
			false,
		);
		expect(isBackupDue({ ...daily, lastRunAt: ago(DAY) }, NOW)).toBe(true);

		const weekly = { enabled: true, frequency: "weekly" as const, keep: 7 };
		expect(isBackupDue({ ...weekly, lastRunAt: ago(3 * DAY) }, NOW)).toBe(
			false,
		);
		expect(isBackupDue({ ...weekly, lastRunAt: ago(7 * DAY) }, NOW)).toBe(true);

		const monthly = { enabled: true, frequency: "monthly" as const, keep: 7 };
		expect(isBackupDue({ ...monthly, lastRunAt: ago(20 * DAY) }, NOW)).toBe(
			false,
		);
		expect(isBackupDue({ ...monthly, lastRunAt: ago(30 * DAY) }, NOW)).toBe(
			true,
		);
	});

	// A daily cron that fires a few minutes early would otherwise skip a day
	// every time, and the mailbox would quietly fall to every other day.
	it("allows an hour of slack so an early cron does not skip a cycle", () => {
		const daily = { enabled: true, frequency: "daily" as const, keep: 7 };
		expect(
			isBackupDue({ ...daily, lastRunAt: ago(DAY - 5 * 60 * 1000) }, NOW),
		).toBe(true);
		expect(isBackupDue({ ...daily, lastRunAt: ago(DAY - 3 * HOUR) }, NOW)).toBe(
			false,
		);
	});

	it("treats an unreadable timestamp as never run", () => {
		expect(
			isBackupDue(
				{ enabled: true, frequency: "daily", keep: 7, lastRunAt: "nonsense" },
				NOW,
			),
		).toBe(true);
	});
});

describe("keysToRotate", () => {
	const keys = [
		"backups/box/2026-08-01T00-00-00-000Z.mbox",
		"backups/box/2026-08-02T00-00-00-000Z.mbox",
		"backups/box/2026-08-03T00-00-00-000Z.mbox",
		"backups/box/2026-08-04T00-00-00-000Z.mbox",
	];

	it("removes the oldest beyond the retention count", () => {
		expect(keysToRotate(keys, 2)).toEqual([
			"backups/box/2026-08-01T00-00-00-000Z.mbox",
			"backups/box/2026-08-02T00-00-00-000Z.mbox",
		]);
	});

	it("removes nothing while there is room", () => {
		expect(keysToRotate(keys, 4)).toEqual([]);
		expect(keysToRotate(keys, 10)).toEqual([]);
		expect(keysToRotate([], 3)).toEqual([]);
	});

	// Listing order from R2 is not promised to be sorted, and rotating by
	// arrival order would delete whichever came back first.
	it("goes by timestamp, not by the order it was handed", () => {
		expect(keysToRotate([...keys].reverse(), 1)).toEqual(keys.slice(0, 3));
	});

	it("never keeps fewer than one, whatever it is asked", () => {
		expect(keysToRotate(keys, 0)).toHaveLength(3);
		expect(keysToRotate(keys, -5)).toHaveLength(3);
	});

	/**
	 * The monthly tier, which is what stops "empty the mailbox and wait".
	 */
	const daily = (month: string, days: number) =>
		Array.from(
			{ length: days },
			(_, i) =>
				`backups/box/${month}-${String(i + 1).padStart(2, "0")}T00-00-00-000Z.mbox`,
		);

	it("keeps each recent month's newest even when the count is passed", () => {
		const keys = [
			...daily("2026-06", 3),
			...daily("2026-07", 3),
			...daily("2026-08", 3),
		];
		const survivors = keys.filter((k) => !keysToRotate(keys, 2).includes(k));

		// Two by count (the newest two of August), plus June's and July's
		// newest -- August's newest is already one of the two.
		expect(survivors).toEqual([
			"backups/box/2026-06-03T00-00-00-000Z.mbox",
			"backups/box/2026-07-03T00-00-00-000Z.mbox",
			"backups/box/2026-08-02T00-00-00-000Z.mbox",
			"backups/box/2026-08-03T00-00-00-000Z.mbox",
		]);
	});

	/**
	 * The attack the tier is for, played out: the mailbox is emptied and the
	 * daily backups keep running. Under the count alone every good archive is
	 * gone in `keep` days. Here the month before the wipe still has one.
	 */
	it("still holds a pre-wipe archive a month after the mail was destroyed", () => {
		const before = daily("2026-06", 30); // the mail was still there
		const after = daily("2026-07", 30); // emptied on the 1st, still running
		const keys = [...before, ...after];

		const gone = new Set(keysToRotate(keys, 7));
		const survivingFromBefore = before.filter((k) => !gone.has(k));

		expect(survivingFromBefore).toEqual([
			"backups/box/2026-06-30T00-00-00-000Z.mbox",
		]);
	});

	it("lets go of a month once twelve newer ones have their own", () => {
		// Fourteen months, one archive each, so the count tier holds only the
		// newest and the monthly tier decides everything else.
		const keys = Array.from({ length: 14 }, (_, i) => {
			const month = String((i % 12) + 1).padStart(2, "0");
			const year = 2025 + Math.floor(i / 12);
			return `backups/box/${year}-${month}-01T00-00-00-000Z.mbox`;
		}).sort();

		const gone = keysToRotate(keys, 1);
		expect(gone).toEqual([
			"backups/box/2025-01-01T00-00-00-000Z.mbox",
			"backups/box/2025-02-01T00-00-00-000Z.mbox",
		]);
	});

	// An unrecognized key in a bucket of backups is not something to delete
	// on a guess about what it might be. It does sort after every timestamped
	// one and so also takes a slot in the count tier, which is harmless: this
	// application never writes such a key, so one is evidence that something
	// outside it did.
	it("keeps a key whose timestamp it cannot read", () => {
		const keys = ["backups/box/not-a-timestamp.mbox", ...daily("2026-08", 3)];
		const gone = keysToRotate(keys, 1);

		expect(gone).not.toContain("backups/box/not-a-timestamp.mbox");
		// August's newest still survives on the monthly tier.
		expect(gone).not.toContain("backups/box/2026-08-03T00-00-00-000Z.mbox");
	});
});

describe("keys", () => {
	it("names an archive so that sorting by key sorts by time", () => {
		const early = backupKey(
			"box@example.com",
			new Date("2026-08-01T00:00:00Z"),
		);
		const late = backupKey("box@example.com", new Date("2026-09-01T00:00:00Z"));
		expect(early < late).toBe(true);
		expect(early.startsWith(backupKeyPrefix("box@example.com"))).toBe(true);
		expect(early.endsWith(".mbox")).toBe(true);
		// Colons are legal in an R2 key but awkward in a URL and a filename.
		expect(early).not.toContain(":");
	});

	it("keeps one mailbox's archives out of another's prefix", () => {
		expect(backupKeyPrefix("a@example.com")).not.toBe(
			backupKeyPrefix("b@example.com"),
		);
		expect(
			backupKey("a@example.com", new Date()).startsWith(
				backupKeyPrefix("b@example.com"),
			),
		).toBe(false);
	});
});

describe("normalizing what the client sent", () => {
	it("clamps the retention count into range", () => {
		expect(normalizeKeep(7)).toBe(7);
		expect(normalizeKeep(0)).toBe(1);
		expect(normalizeKeep(-3)).toBe(1);
		expect(normalizeKeep(100000)).toBe(365);
		expect(normalizeKeep("nonsense")).toBe(1);
		expect(normalizeKeep(undefined)).toBe(1);
		expect(normalizeKeep(3.7)).toBe(3);
	});

	it("falls back to daily for a frequency it does not know", () => {
		expect(normalizeFrequency("weekly")).toBe("weekly");
		expect(normalizeFrequency("hourly")).toBe("daily");
		expect(normalizeFrequency(undefined)).toBe("daily");
	});
});
