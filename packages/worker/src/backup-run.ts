/**
 * The scheduled pass: look at every mailbox, back up the ones that are due.
 *
 * The cron fires once a day for the whole Worker, not once per mailbox, so
 * this decides per mailbox whether its own frequency has come round (see
 * isBackupDue). A mailbox that is not due costs one settings read.
 *
 * Every run records what happened on the mailbox, success or failure. A
 * backup that quietly stops working is worse than no backup at all: the
 * mailbox looks protected right up until the day someone needs it. The
 * settings screen shows this, so "it has not run since March" is visible
 * without going to the logs.
 */

import type { AutoBackupSettings } from "./auto-backup";
import { isBackupDue, normalizeKeep } from "./auto-backup";
import { writeMailboxBackup } from "./backup-writer";
import { listMailboxes, updateMailboxSettings } from "./mailbox-records";
import type { Env } from "./types";

/** Writes the outcome back onto the mailbox. Only the fields this run owns. */
async function recordResult(
	env: Env,
	mailboxId: string,
	result: NonNullable<AutoBackupSettings["lastResult"]>,
): Promise<void> {
	await updateMailboxSettings(env, mailboxId, (settings) => {
		settings.autoBackup = {
			...settings.autoBackup,
			lastRunAt: result.at,
			lastResult: result,
		};
	});
}

export interface BackupPassSummary {
	considered: number;
	ran: number;
	failed: number;
}

export async function runScheduledBackups(
	env: Env,
	now: Date = new Date(),
): Promise<BackupPassSummary> {
	const mailboxes = await listMailboxes(env);
	const summary: BackupPassSummary = {
		considered: mailboxes.length,
		ran: 0,
		failed: 0,
	};

	for (const mailbox of mailboxes) {
		if (!isBackupDue(mailbox.settings.autoBackup, now.getTime())) continue;

		const keep = normalizeKeep(mailbox.settings.autoBackup?.keep);
		try {
			const written = await writeMailboxBackup(env, mailbox.id, now, keep);
			summary.ran += 1;
			await recordResult(env, mailbox.id, {
				at: now.toISOString(),
				ok: true,
				messages: written.messages,
				bytes: written.bytes,
				removed: written.removed,
			});
		} catch (e) {
			// One mailbox failing must not stop the others: they are separate
			// backups and a large mailbox running out of budget should not
			// take a small one down with it.
			summary.failed += 1;
			await recordResult(env, mailbox.id, {
				at: now.toISOString(),
				ok: false,
				error: String(e instanceof Error ? e.message : e).slice(0, 300),
			}).catch(() => {});
		}
	}

	return summary;
}
