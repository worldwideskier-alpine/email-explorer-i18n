import { describe, expect, it } from "vitest";
// Plain JS on purpose: it runs under node from the night-check workflow.
import {
	judgeNight,
	nightSummary,
	parseQuietly,
} from "../../scripts/night-check.mjs";

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

	// On 2026-10-13 the runtime called the cron twice for one firing, and
	// only two start times said so. Times and a count, never a mailbox.
	it("says how many calls the firing had, and when each began", () => {
		const twice = {
			...wellEnded(),
			startedAt: "2026-10-13T18:00:00.000Z",
			owner: "a",
			calls: [
				{
					scheduledTime: "2026-10-13T18:00:00.000Z",
					at: "2026-10-13T18:00:12.604Z",
				},
				{
					scheduledTime: "2026-10-13T18:00:00.000Z",
					at: "2026-10-13T18:00:20.053Z",
					stoodAside: true,
				},
			],
		};
		expect(nightSummary(twice)).toContain(
			"scheduled 2026-10-13T18:00:00.000Z, 2 call(s) began 2026-10-13T18:00:12.604Z, 2026-10-13T18:00:20.053Z (stood aside)",
		);
		expect(nightSummary(twice)).not.toContain("@");
		expect(nightSummary(wellEnded())).not.toContain("call(s)");
	});
	// 2026-10-25: the call that owned the night wrote where the backups had
	// got to two minutes in and was heard from no more; both archives were
	// written. Each night now writes how it ended beside the list of nights
	// the call began, and a call that ends early is judged by those.
	const endedEarly = () => ({
		startedAt: "2026-10-05T18:00:04.112Z",
		owner: "a",
		backupProgress: {
			mailbox: MAILBOX,
			index: 1,
			of: 2,
			messages: 0,
			at: "2026-10-05T18:00:30.000Z",
		},
		appointed: [MAILBOX, "other@mail.example.org"],
		nights: {
			[MAILBOX]: {
				endedAt: "2026-10-05T18:01:49.000Z",
				backup: { state: "ran" },
				purge: { state: "skipped" },
			},
			"other@mail.example.org": {
				endedAt: "2026-10-05T18:02:48.000Z",
				backup: { state: "ran" },
				purge: { state: "ran", deleted: 3 },
			},
		},
	});

	it("does not fail a night whose call ended early when every night ended well", () => {
		const verdict = judgeNight(endedEarly(), [], NOW, 0);
		expect(verdict.trouble).toEqual([]);
		expect(verdict.pending).toBeUndefined();
		expect(verdict.notes).toEqual([
			"the run's own call ended before writing its end; all 2 mailbox night(s) it began wrote theirs",
		]);
		expect(nightSummary(endedEarly())).toContain(
			"2 of 2 night(s) wrote their end; backups 2 ran, 0 failed of 2; spam purge 1 ran, 0 failed of 2, 3 message(s) removed",
		);
	});

	it("fails what such a night did leave undone, by the nights' own word", () => {
		const night = endedEarly();
		night.nights[MAILBOX].backup = {
			state: "failed",
			error: "R2 said no",
		} as never;
		expect(judgeNight(night, [], NOW, 0).trouble).toEqual([
			"backups: 1 of 2 mailbox(es) failed",
		]);
		expect(judgeNight(endedEarly(), [], NOW, 2).trouble).toEqual([
			"unfinished deletions: 2 mailbox deletion(s) still not finished; the run ended before it reached them",
		]);
		expect(judgeNight(endedEarly(), [], NOW).trouble).toEqual([
			"unfinished deletions: the run ended before it reached them, and how many wait was not read",
		]);
		expect(
			judgeNight(endedEarly(), ["backup-carry/x.json"], NOW, 0).trouble,
		).toHaveLength(1);
	});

	it("waits for a night not yet ended, and fails it once patience runs out", () => {
		const night = endedEarly();
		delete (night.nights as Record<string, unknown>)["other@mail.example.org"];
		const verdict = judgeNight(night, ["backup-carry/x.json"], NOW, 0);
		expect(verdict.trouble).toEqual([]);
		expect(verdict.pending).toContain("1 of 2 mailbox night(s) not ended yet");
		expect(verdict.pending).not.toContain("@");
	});

	it("still says where a call got to when it never said which nights it began", () => {
		const { appointed: _, nights: __, ...before } = endedEarly();
		expect(judgeNight(before, [], NOW, 0).trouble).toEqual([
			expect.stringContaining("cut off inside the backups"),
		]);
	});

	// Node quotes the text around a JSON fault, and what is read here holds
	// mailbox addresses: a damaged object put one into the public log.
	it("says an object did not parse without quoting it", () => {
		const damaged = `["${MAILBOX}", ${MAILBOX}]`;
		expect(() => JSON.parse(damaged)).toThrow(/@/);
		expect(() => parseQuietly(damaged, "the list")).toThrow(
			"the list did not parse",
		);
		try {
			parseQuietly(damaged, "the list");
		} catch (e) {
			expect(String(e)).not.toContain("@");
		}
		expect(parseQuietly('["a"]', "the list")).toEqual(["a"]);
	});
});
