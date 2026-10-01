/**
 * Every mailbox's backup, or every mailbox's purge, at once -- for tests.
 *
 * In production these run inside each mailbox's own night (mailbox-night.ts)
 * and nothing runs "the backup pass" over every mailbox any more. A test
 * about what one backup or one purge does to its mailbox still wants to say
 * "run tonight's backups" in one line; these say it, through the same
 * per-mailbox functions the nights use, all at once as the nights are.
 */
import { isBackupDue } from "../../src/auto-backup";
import type { BackupPassSummary, BackupProgress } from "../../src/backup-run";
import { backupOneMailbox } from "../../src/backup-run";
import type { TimeLimits } from "../../src/deadline";
import { listMailboxes } from "../../src/mailbox-records";
import type { SpamPurgeSummary } from "../../src/spam-purge-run";
import { purgeOneMailbox } from "../../src/spam-purge-run";
import type { Env } from "../../src/types";

export async function runScheduledBackups(
	env: Env,
	now: Date = new Date(),
	onProgress?: (progress: BackupProgress) => Promise<void>,
	limits: TimeLimits = {},
): Promise<BackupPassSummary> {
	const mailboxes = await listMailboxes(env);
	const due = mailboxes.filter((mailbox) =>
		isBackupDue(mailbox.settings.autoBackup, now.getTime()),
	);
	const outcomes = await Promise.all(
		due.map((mailbox, at) =>
			backupOneMailbox(
				env,
				mailbox,
				now,
				limits,
				onProgress &&
					((messages) =>
						onProgress({
							mailbox: mailbox.id,
							index: at + 1,
							of: due.length,
							messages,
						})),
			),
		),
	);
	return {
		considered: mailboxes.length,
		ran: outcomes.filter((outcome) => outcome === "ran").length,
		failed: outcomes.filter((outcome) => outcome === "failed").length,
	};
}

export async function runScheduledSpamPurge(
	env: Env,
	now: Date = new Date(),
	limits: TimeLimits = {},
): Promise<SpamPurgeSummary> {
	const mailboxes = await listMailboxes(env);
	const on = mailboxes.filter(
		(mailbox) => mailbox.settings.spamRetention?.enabled,
	);
	const results = await Promise.all(
		on.map((mailbox) => purgeOneMailbox(env, mailbox, now, limits)),
	);
	return {
		considered: mailboxes.length,
		ran: results.filter((result) => result.ok).length,
		deleted: results.reduce((sum, result) => sum + result.deleted, 0),
		failed: results.filter((result) => !result.ok).length,
	};
}
