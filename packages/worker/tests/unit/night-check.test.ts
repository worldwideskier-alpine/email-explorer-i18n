import { describe, expect, it } from "vitest";
// Plain JS on purpose: it runs under node from the night-check workflow.
import { judgeNight, nightSummary } from "../../scripts/night-check.mjs";

/**
 * The evening question the scheduled workflow asks: did last night's run end
 * well? Each failure below is one the run has had, or one a record can show,
 * and each was found by hand before this asked every night.
 */

const NOW = new Date("2026-10-05T18:30:00.000Z");
const MAILBOX = "someone@mail.example.org";

const wellEnded = () => ({
	startedAt: "2026-10-05T18:00:04.112Z",
	backupProgress: {
		mailbox: MAILBOX,
		index: 2,
		of: 2,
		messages: 1756,
		at: "2026-10-05T18:01:58.000Z",
	},
	backups: {
		finishedAt: "2026-10-05T18:02:20.000Z",
		considered: 2,
		ran: 2,
		failed: 0,
	},
	spamPurge: {
		finishedAt: "2026-10-05T18:02:30.000Z",
		considered: 2,
		ran: 2,
		failed: 0,
		deleted: 5,
	},
	unfinishedDeletions: { finished: 0, left: 0 },
	finishedAt: "2026-10-05T18:02:31.000Z",
	continuing: [],
});

describe("the night check", () => {
	it("passes a night that ended well", () => {
		expect(judgeNight(wellEnded(), [], NOW)).toEqual({ trouble: [] });
	});

	it("fails when there is no record at all", () => {
		expect(judgeNight(null, [], NOW).trouble).toHaveLength(1);
	});

	it("fails when tonight's run never started", () => {
		const yesterday = {
			...wellEnded(),
			startedAt: "2026-10-04T18:00:04.112Z",
		};
		const { trouble, pending } = judgeNight(yesterday, [], NOW);
		expect(pending).toBeUndefined();
		expect(trouble[0]).toContain("no run has started in the last 24 hours");
	});

	it("waits for a run still inside its time", () => {
		const { finishedAt: _, ...running } = wellEnded();
		const early = new Date("2026-10-05T18:10:00.000Z");
		expect(judgeNight(running, [], early)).toEqual({
			trouble: [],
			pending: "the run has not reached its end yet",
		});
	});

	// 2026-09-04: the whole record was its start.
	it("fails a run cut off inside the backups, and says where", () => {
		const cut = judgeNight({ startedAt: "2026-10-05T18:00:04.112Z" }, [], NOW);
		expect(cut.trouble[0]).toContain("before any mailbox reported");

		const { finishedAt: _, backups: __, ...partway } = wellEnded();
		const where = judgeNight(partway, [], NOW).trouble[0];
		expect(where).toContain("on mailbox 2 of 2 with 1756 message(s) written");
	});

	// 2026-09-22: the pass recorded its failure, and the purge never ran.
	it("fails a pass that failed, threw or recorded nothing", () => {
		const night = wellEnded();
		night.backups = { ...night.backups, ran: 1, failed: 1 };
		expect(judgeNight(night, [], NOW).trouble).toEqual([
			"backups: 1 of 2 mailbox(es) failed",
		]);

		const threw = wellEnded();
		threw.backups = { ...threw.backups, error: "out-of-time" } as never;
		expect(judgeNight(threw, [], NOW).trouble).toEqual([
			"backups: out-of-time",
		]);

		const { spamPurge: _, ...noPurge } = wellEnded();
		expect(judgeNight(noPurge, [], NOW).trouble).toEqual([
			"spam purge: the run recorded nothing",
		]);
	});

	it("fails while deletions are left unfinished, or could not be read", () => {
		const left = wellEnded();
		left.unfinishedDeletions = { finished: 0, left: 1 };
		expect(judgeNight(left, [], NOW).trouble[0]).toContain(
			"1 mailbox deletion(s) still not finished",
		);
		const unread = wellEnded();
		unread.unfinishedDeletions = {
			finished: 0,
			left: -1,
			error: "R2 list failed",
		} as never;
		expect(judgeNight(unread, [], NOW).trouble[0]).toContain("R2 list failed");
	});

	it("waits while a night carries on, and does not call its pause litter", () => {
		const carrying = {
			...wellEnded(),
			continuing: [{ mailbox: MAILBOX, backup: true }],
		};
		const verdict = judgeNight(
			carrying,
			["backup-carry/x.json", "backup-carry/x.bin"],
			NOW,
		);
		expect(verdict.trouble).toEqual([]);
		expect(verdict.pending).toContain("1 mailbox(es) still carrying");
	});

	it("fails a paused backup nothing carries on", () => {
		const verdict = judgeNight(
			wellEnded(),
			["backup-carry/x.json", "backup-carry/x.bin"],
			NOW,
		);
		expect(verdict.trouble).toEqual([
			"2 object(s) of a paused backup left behind with no night carrying it on",
		]);
	});

	// The log is public and a mailbox's id is its address.
	it("names no mailbox in anything it says", () => {
		const { finishedAt: _, backups: __, ...partway } = wellEnded();
		const said = [
			nightSummary(wellEnded()),
			...judgeNight(partway, [], NOW).trouble,
			judgeNight(
				{ ...wellEnded(), continuing: [{ mailbox: MAILBOX, backup: true }] },
				[],
				NOW,
			).pending,
		].join("\n");
		expect(said).not.toContain("@");
		expect(nightSummary(wellEnded())).toContain(
			"spam purge 2 ran, 0 failed of 2, 5 message(s) removed",
		);
	});
});
