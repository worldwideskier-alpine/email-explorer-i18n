/**
 * Everything the daily cron does, in the order it has to do it.
 *
 * The order is the point of this file existing rather than the two calls
 * sitting inline in the handler: **the backup runs first and the spam purge
 * second**, so a message the purge deletes tonight is already inside tonight's
 * archive and stays recoverable for as long as that archive is kept.
 *
 * Reversed, the purge would delete a message and the backup taken minutes
 * later would be the first one without it -- a permanent deletion with no copy
 * anywhere, which is not something to offer behind a checkbox. Nothing in the
 * type system enforces the ordering, so it is asserted by a test instead; see
 * scheduled-order.test.ts.
 *
 * The purge runs even if the backup pass threw. A backup failing is not a
 * reason to stop deleting old spam -- the backup pass records its own failure
 * on the mailbox, and leaving the purge undone as well would mean one broken
 * mailbox quietly stops both jobs for every mailbox behind it in the loop.
 * What the purge may delete does depend on the backups, though: for a mailbox
 * with backups on, only what an archive in the bucket already holds. The
 * order alone promised that and did not deliver it on a night the backup
 * failed or was not due; see spam-purge-run.ts.
 *
 * The run also writes down that it happened; see maintenance-record.ts. Each
 * pass records its outcome on the mailboxes it touched, which answers "did my
 * backup run" but not "did the run finish" -- and those came apart in
 * production, where the backup recorded a success and the purge recorded
 * nothing at all, ever.
 */

import type { BackupPassSummary } from "./backup-run";
import { runScheduledBackups } from "./backup-run";
import { within } from "./deadline";
import type { UnfinishedDeletionsSummary } from "./mailbox-destroy";
import { finishUnfinishedDeletions } from "./mailbox-destroy";
import type { MaintenanceRecord } from "./maintenance-record";
import { archiveLastRun, writeMaintenanceRecord } from "./maintenance-record";
import type { SpamPurgeSummary } from "./spam-purge-run";
import { runScheduledSpamPurge } from "./spam-purge-run";
import type { Env } from "./types";

export interface MaintenanceSummary {
	backups?: BackupPassSummary;
	spamPurge?: SpamPurgeSummary;
	unfinishedDeletions?: UnfinishedDeletionsSummary;
	backupError?: string;
}

const message = (e: unknown): string =>
	String(e instanceof Error ? e.message : e).slice(0, 300);

/**
 * The runtime ends a cron invocation at fifteen minutes of wall time, and says
 * nothing when it does: on 2026-09-22 the run was `exceededWallTime` at
 * 899968 ms. Measured nights take five to eight minutes.
 *
 * So the passes are given ends of their own inside that, with room after each
 * for what follows: the backups must be done ten minutes in, the purge by
 * thirteen, which leaves two for writing down how it went. A pass that runs
 * out stops at its next call and says so, rather than taking the night with
 * it; see deadline.ts.
 */
export const BACKUPS_BY_MS = 10 * 60_000;
export const PURGE_BY_MS = 13 * 60_000;
/** Deletions left unfinished by root (see mailbox-destroy.ts) go last. */
export const DELETIONS_BY_MS = 14 * 60_000;

/** How long a write of the record itself may take before it is let go. */
const NOTE_LIMIT_MS = 10_000;

/** The passes' ends as offsets from the start, and the per-call limit. Tests shrink them. */
export interface MaintenanceLimits {
	backupsByMs?: number;
	purgeByMs?: number;
	deletionsByMs?: number;
	callLimitMs?: number;
}

/**
 * The run is written down as it goes, not summarised at the end.
 *
 * Recording only on completion would record nothing at all in the one case
 * worth recording -- an invocation that does not reach its end. So the record
 * is put at the start with no ending, and updated as each pass finishes; what
 * is missing from it afterwards is the finding. Failing to write it must not
 * take the run down with it, which is the whole point of a diagnostic.
 */
async function note(
	env: Env,
	record: MaintenanceRecord,
): Promise<MaintenanceRecord> {
	// Bounded as well: a write that hangs here would hold the run exactly as
	// a hung backup did.
	await within(
		writeMaintenanceRecord(env, record),
		NOTE_LIMIT_MS,
		"writing the maintenance record",
	).catch(() => {});
	return record;
}

export async function runScheduledMaintenance(
	env: Env,
	now: Date = new Date(),
	limits: MaintenanceLimits = {},
): Promise<MaintenanceSummary> {
	// The budget runs from when this invocation started, which is not `now`:
	// a test passes a fixed date for what the passes compare against.
	const started = Date.now();
	const backupsBy = started + (limits.backupsByMs ?? BACKUPS_BY_MS);
	const purgeBy = started + (limits.purgeByMs ?? PURGE_BY_MS);
	const deletionsBy = started + (limits.deletionsByMs ?? DELETIONS_BY_MS);

	const summary: MaintenanceSummary = {};
	// Last night's record moves into the history before tonight's replaces
	// it; see maintenance-record.ts.
	await within(
		archiveLastRun(env),
		NOTE_LIMIT_MS,
		"keeping the last run's record",
	).catch(() => {});
	const record: MaintenanceRecord = { startedAt: now.toISOString() };
	await note(env, record);

	try {
		// The pass says where it is as it goes, and each report is written
		// straight out. Nothing else survives an invocation that is cut off
		// inside the backups -- and that is what has been happening.
		summary.backups = await runScheduledBackups(
			env,
			now,
			async (progress) => {
				record.backupProgress = { ...progress, at: new Date().toISOString() };
				await note(env, record);
			},
			{ deadline: backupsBy, callLimitMs: limits.callLimitMs },
		);
		record.backups = {
			finishedAt: new Date().toISOString(),
			...summary.backups,
		};
	} catch (e) {
		summary.backupError = message(e);
		record.backups = {
			finishedAt: new Date().toISOString(),
			considered: 0,
			ran: 0,
			failed: 0,
			error: summary.backupError,
		};
	}
	await note(env, record);

	let purgeFailure: unknown;
	try {
		summary.spamPurge = await runScheduledSpamPurge(env, now, {
			deadline: purgeBy,
			callLimitMs: limits.callLimitMs,
		});
		record.spamPurge = {
			finishedAt: new Date().toISOString(),
			...summary.spamPurge,
		};
	} catch (e) {
		record.spamPurge = {
			finishedAt: new Date().toISOString(),
			considered: 0,
			ran: 0,
			failed: 0,
			error: message(e),
		};
		purgeFailure = e;
	}

	// Whatever the purge did: a deletion left half done is somebody's mail
	// still stored after they were deleted, and nothing else finishes it.
	try {
		summary.unfinishedDeletions = await finishUnfinishedDeletions(env, {
			deadline: deletionsBy,
		});
		record.unfinishedDeletions = summary.unfinishedDeletions;
	} catch (e) {
		record.unfinishedDeletions = { finished: 0, left: -1, error: message(e) };
	}

	record.finishedAt = new Date().toISOString();
	await note(env, record);
	if (purgeFailure !== undefined) throw purgeFailure;
	return summary;
}
