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
			expect(isBackupDue({ enabled: true, frequency, keep: 7 }, NOW)).toBe(true);
		}
	});

	it("waits out the interval", () => {
		const daily = { enabled: true, frequency: "daily" as const, keep: 7 };
		expect(isBackupDue({ ...daily, lastRunAt: ago(2 * HOUR) }, NOW)).toBe(false);
		expect(isBackupDue({ ...daily, lastRunAt: ago(DAY) }, NOW)).toBe(true);

		const weekly = { enabled: true, frequency: "weekly" as const, keep: 7 };
		expect(isBackupDue({ ...weekly, lastRunAt: ago(3 * DAY) }, NOW)).toBe(false);
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
});

describe("keys", () => {
	it("names an archive so that sorting by key sorts by time", () => {
		const early = backupKey("box@example.com", new Date("2026-08-01T00:00:00Z"));
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
