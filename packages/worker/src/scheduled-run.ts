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
 */

import type { BackupPassSummary } from "./backup-run";
import { runScheduledBackups } from "./backup-run";
import type { SpamPurgeSummary } from "./spam-purge-run";
import { runScheduledSpamPurge } from "./spam-purge-run";
import type { Env } from "./types";

export interface MaintenanceSummary {
	backups?: BackupPassSummary;
	spamPurge?: SpamPurgeSummary;
	backupError?: string;
}

export async function runScheduledMaintenance(
	env: Env,
	now: Date = new Date(),
): Promise<MaintenanceSummary> {
	const summary: MaintenanceSummary = {};

	try {
		summary.backups = await runScheduledBackups(env, now);
	} catch (e) {
		summary.backupError = String(e instanceof Error ? e.message : e);
	}

	summary.spamPurge = await runScheduledSpamPurge(env, now);
	return summary;
}
