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
 *
 * The run also writes down that it happened; see maintenance-record.ts. Each
 * pass records its outcome on the mailboxes it touched, which answers "did my
 * backup run" but not "did the run finish" -- and those came apart in
 * production, where the backup recorded a success and the purge recorded
 * nothing at all, ever.
 */

import type { BackupPassSummary } from "./backup-run";
import { runScheduledBackups } from "./backup-run";
import type { MaintenanceRecord } from "./maintenance-record";
import { writeMaintenanceRecord } from "./maintenance-record";
import type { SpamPurgeSummary } from "./spam-purge-run";
import { runScheduledSpamPurge } from "./spam-purge-run";
import type { Env } from "./types";

export interface MaintenanceSummary {
	backups?: BackupPassSummary;
	spamPurge?: SpamPurgeSummary;
	backupError?: string;
}

const message = (e: unknown): string =>
	String(e instanceof Error ? e.message : e).slice(0, 300);

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
	await writeMaintenanceRecord(env, record).catch(() => {});
	return record;
}

export async function runScheduledMaintenance(
	env: Env,
	now: Date = new Date(),
): Promise<MaintenanceSummary> {
	const summary: MaintenanceSummary = {};
	const record: MaintenanceRecord = { startedAt: now.toISOString() };
	await note(env, record);

	try {
		// The pass says where it is as it goes, and each report is written
		// straight out. Nothing else survives an invocation that is cut off
		// inside the backups -- and that is what has been happening.
		summary.backups = await runScheduledBackups(env, now, async (progress) => {
			record.backupProgress = { ...progress, at: new Date().toISOString() };
			await note(env, record);
		});
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

	try {
		summary.spamPurge = await runScheduledSpamPurge(env, now);
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
		record.finishedAt = new Date().toISOString();
		await note(env, record);
		throw e;
	}

	record.finishedAt = new Date().toISOString();
	await note(env, record);
	return summary;
}
