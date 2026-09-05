import { describe, expect, it } from "vitest";
import {
	type MaintenanceRecord,
	maintenanceDeleted,
	maintenanceDuration,
	maintenanceErrorDetail,
	maintenanceFinishedCleanly,
	maintenanceStoppedDetail,
	maintenanceStoppedKey,
} from "./maintenance";

/**
 * The sentence a run that did not finish gets.
 *
 * This is the screen that exists to say where the nightly run stopped, and it
 * had one sentence for two different faults. The live record was
 *
 *   {"startedAt":"2026-09-03T18:14:09.407Z"}
 *
 * and nothing else: no backup for two nights, and the spam purge -- which runs
 * after the backups -- had never once recorded a thing. The screen said "it
 * ended before reaching the spam purge", which is true, and is also what it
 * says about a run that finished every backup and died one step later. Those
 * need different fixes.
 */

const START = "2026-09-03T18:14:09.407Z";

const run = (over: Partial<MaintenanceRecord> = {}): MaintenanceRecord => ({
	startedAt: START,
	...over,
});

const progress = {
	mailbox: "info@example.test",
	index: 1,
	of: 2,
	messages: 1250,
	at: "2026-09-03T18:14:41.000Z",
};

describe("which sentence an unfinished run gets", () => {
	// The one this was written for: killed inside the backups.
	it("says so when the backup pass never handed control back", () => {
		expect(maintenanceStoppedKey(run({ backupProgress: progress }))).toBe(
			"root.maintenance.killedInBackup",
		);
	});

	/**
	 * And not when the backups finished. `backups` is written whether the pass
	 * returned or threw, so its presence means the pass ended on its own terms
	 * and the run died somewhere after it -- a different fault, and the reason
	 * this cannot be decided on the progress alone.
	 */
	it("does not say so when the backups completed", () => {
		expect(
			maintenanceStoppedKey(
				run({
					backupProgress: progress,
					backups: { finishedAt: "2026-09-03T18:16:00.000Z", ran: 2 },
				}),
			),
		).toBe("root.maintenance.notReached");
	});

	// Reaching the purge and not finishing is its own case, and still is.
	it("still tells the purge apart", () => {
		expect(
			maintenanceStoppedKey(
				run({
					backupProgress: progress,
					backups: { finishedAt: "2026-09-03T18:16:00.000Z", ran: 2 },
					spamPurge: { finishedAt: "2026-09-03T18:16:30.000Z", ran: 2 },
				}),
			),
		).toBe("root.maintenance.unfinished");
	});

	/**
	 * A record from before this field existed -- which includes the very run
	 * that motivated it -- reads as it did before rather than as a new claim.
	 */
	it("says what it used to about a record with no progress in it", () => {
		expect(maintenanceStoppedKey(run())).toBe("root.maintenance.notReached");
		expect(maintenanceStoppedKey(null)).toBe("root.maintenance.notReached");
		expect(maintenanceStoppedKey(undefined)).toBe(
			"root.maintenance.notReached",
		);
	});
});

describe("how far it got", () => {
	it("names the mailbox, its place in the pass, and the count", () => {
		expect(maintenanceStoppedDetail(run({ backupProgress: progress }))).toBe(
			"info@example.test 1/2 · 1250",
		);
	});

	// Nothing recorded, nothing shown -- rather than an empty parenthesis.
	it("is empty when nothing was recorded", () => {
		expect(maintenanceStoppedDetail(run())).toBe("");
		expect(maintenanceStoppedDetail(null)).toBe("");
	});
});

/**
 * What a finished run reports.
 *
 * The line said "backups 2, spam purge 2" -- and the second 2 was the number
 * of *mailboxes* the purge visited, sitting next to a number of mailboxes and
 * reading as messages. On the first night the purge ever ran it said 2 while
 * removing 5. The live record:
 *
 *   "spamPurge": {"considered":2,"ran":2,"deleted":5,"failed":0}
 */
describe("what a finished run removed", () => {
	it("counts messages, not mailboxes", () => {
		expect(
			maintenanceDeleted(
				run({
					spamPurge: {
						finishedAt: "2026-09-04T18:08:52.622Z",
						ran: 2,
						deleted: 5,
					},
				}),
			),
		).toBe(5);
	});

	// A Worker older than this screen recorded no count. Zero is not a claim
	// that nothing was deleted -- there is no way to tell from such a record --
	// but it is the smaller lie, and the alternative is an empty gap.
	it("reads a record with no count as zero", () => {
		expect(
			maintenanceDeleted(
				run({ spamPurge: { finishedAt: "2026-09-04T18:08:52.622Z", ran: 2 } }),
			),
		).toBe(0);
		expect(maintenanceDeleted(run())).toBe(0);
		expect(maintenanceDeleted(null)).toBe(0);
	});
});

/**
 * How long it took, which was never shown.
 *
 * The run that had been being cut off now finishes, and the live record says
 * in how long: started 18:00:07.422Z, finished 18:08:52.622Z. Eight and three
 * quarter minutes is not comfortable, and the only way to notice it creeping
 * back up is to have it on the screen before the night it stops finishing.
 */
describe("how long the run took", () => {
	it("is minutes and seconds", () => {
		expect(
			maintenanceDuration({
				startedAt: "2026-09-04T18:00:07.422Z",
				finishedAt: "2026-09-04T18:08:52.622Z",
			}),
		).toBe("8m45s");
	});

	it("drops the minutes when there are none", () => {
		expect(
			maintenanceDuration({
				startedAt: "2026-09-04T18:00:07.000Z",
				finishedAt: "2026-09-04T18:00:10.000Z",
			}),
		).toBe("3s");
	});

	// A run with no end has no duration, and that is the case the line above
	// it is for -- saying "0s" there would read as a run that finished at once.
	/**
	 * A dash, not an empty string. The sentence has a slot for this and a
	 * separator after it, so nothing renders as "finished ( / 2 backed up ...)"
	 * -- in all 73 of them.
	 */
	it("says a dash about a run it cannot time", () => {
		expect(maintenanceDuration(run())).toBe("—");
		expect(maintenanceDuration(null)).toBe("—");
	});

	// Clocks are not ours and a record is not ours to trust.
	it("says a dash when the record makes no sense", () => {
		expect(
			maintenanceDuration({
				startedAt: "2026-09-04T18:08:52.622Z",
				finishedAt: "2026-09-04T18:00:07.422Z",
			}),
		).toBe("—");
		expect(
			maintenanceDuration({ startedAt: "not a date", finishedAt: "nor this" }),
		).toBe("—");
	});
});

/**
 * A run that reached its end with a pass that threw.
 *
 * `finishedAt` was the whole test for "it went well", and it is set on the
 * failure paths too. The spam purge sets it explicitly before rethrowing
 * (scheduled-run.ts:99-109, and maintenance-record.test.ts has asserted that
 * exact record since before anyone looked at what it rendered as); the backup
 * pass sets its own `error` and lets the run carry on, so the purge sets it a
 * moment later.
 *
 * Either way the screen said, in calm grey, "finished (... / 0 spam deleted)"
 * about a night the purge had crashed -- and the recorded `error` was shown
 * nowhere at all. That is the exact failure this screen exists to prevent.
 */
describe("a run that ended with a pass that failed", () => {
	const purgeThrew = run({
		finishedAt: "2026-09-04T18:08:52.622Z",
		backups: { finishedAt: "2026-09-04T18:08:49.887Z", ran: 2 },
		spamPurge: {
			finishedAt: "2026-09-04T18:08:52.622Z",
			ran: 0,
			error: "bucket unavailable",
		},
	});

	// The one the reviews found.
	it("is not reported as simply finished", () => {
		expect(maintenanceFinishedCleanly(purgeThrew)).toBe(false);
		expect(maintenanceStoppedKey(purgeThrew)).toBe(
			"root.maintenance.finishedWithError",
		);
		expect(maintenanceStoppedDetail(purgeThrew)).toBe(
			"spamPurge: bucket unavailable",
		);
	});

	/**
	 * And the half neither review mentioned: the backup pass records its error
	 * and does *not* set `finishedAt` -- it carries on to the purge, which
	 * sets it. So a failed backup night reached the same calm sentence, as
	 * "finished, 0 backed up".
	 */
	it("is not reported as finished when it was the backups that failed", () => {
		const backupThrew = run({
			finishedAt: "2026-09-04T18:08:52.622Z",
			backups: {
				finishedAt: "2026-09-04T18:00:20.000Z",
				ran: 0,
				error: "bucket unavailable",
			},
			spamPurge: { finishedAt: "2026-09-04T18:08:52.622Z", ran: 2, deleted: 5 },
		});

		expect(maintenanceFinishedCleanly(backupThrew)).toBe(false);
		expect(maintenanceStoppedDetail(backupThrew)).toBe(
			"backups: bucket unavailable",
		);
	});

	// Both, which is possible and must not lose one of them.
	it("names both when both failed", () => {
		expect(
			maintenanceErrorDetail(
				run({
					backups: { finishedAt: "x", ran: 0, error: "one" },
					spamPurge: { finishedAt: "y", ran: 0, error: "two" },
				}),
			),
		).toBe("backups: one · spamPurge: two");
	});

	/**
	 * The error outranks "it did not reach the purge": a run that threw *in*
	 * the purge has a `spamPurge` as well, and would otherwise be described as
	 * one that merely never got there.
	 */
	it("outranks the sentence for a run that stopped", () => {
		expect(maintenanceStoppedKey(purgeThrew)).not.toBe(
			"root.maintenance.unfinished",
		);
	});

	// And a clean run is still clean, on all three of the things it decides.
	it("leaves a run that worked alone", () => {
		const fine = run({
			finishedAt: "2026-09-04T18:08:52.622Z",
			backups: { finishedAt: "2026-09-04T18:08:49.887Z", ran: 2 },
			spamPurge: { finishedAt: "2026-09-04T18:08:52.622Z", ran: 2, deleted: 5 },
		});

		expect(maintenanceFinishedCleanly(fine)).toBe(true);
		expect(maintenanceErrorDetail(fine)).toBe("");
		expect(maintenanceDeleted(fine)).toBe(5);
	});
});
