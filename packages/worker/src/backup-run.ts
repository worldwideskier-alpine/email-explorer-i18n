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

/** Where the pass has got to, for a run that may not live to report itself. */
export interface BackupProgress {
	mailbox: string;
	/** 1-based position among the mailboxes that were due, and how many. */
	index: number;
	of: number;
	/** Messages written into this mailbox's archive so far. */
	messages: number;
}

/**
 * The most overdue first.
 *
 * The order used to be whatever `listMailboxes` returned, which is fine only
 * while every mailbox gets its turn. When an invocation stops finishing, it
 * stops finishing partway through the list -- so a fixed order means the
 * mailboxes at the front are backed up every night and the ones behind them
 * are never backed up again, silently, while their settings screen goes on
 * showing the last time they were.
 *
 * Sorting by when each last ran makes that self-correcting: a mailbox missed
 * tonight is at the front tomorrow. Never-run sorts first, because it has been
 * waiting longest of all.
 */
function mostOverdueFirst(
	mailboxes: Awaited<ReturnType<typeof listMailboxes>>,
): typeof mailboxes {
	return [...mailboxes].sort((a, b) => {
		const at = a.settings.autoBackup?.lastRunAt ?? "";
		const bt = b.settings.autoBackup?.lastRunAt ?? "";
		// ISO-8601 UTC sorts correctly as text, and "" sorts before all of it.
		return at < bt ? -1 : at > bt ? 1 : 0;
	});
}

export async function runScheduledBackups(
	env: Env,
	now: Date = new Date(),
	/**
	 * Called as the pass moves through the mailboxes. Its failures are the
	 * caller's problem, not this pass's: a diagnostic that can stop the backup
	 * is worse than no diagnostic.
	 */
	onProgress?: (progress: BackupProgress) => Promise<void>,
): Promise<BackupPassSummary> {
	const mailboxes = await listMailboxes(env);
	const summary: BackupPassSummary = {
		considered: mailboxes.length,
		ran: 0,
		failed: 0,
	};

	const due = mostOverdueFirst(mailboxes).filter((mailbox) =>
		isBackupDue(mailbox.settings.autoBackup, now.getTime()),
	);

	for (const [at, mailbox] of due.entries()) {
		const where = (messages: number): BackupProgress => ({
			mailbox: mailbox.id,
			index: at + 1,
			of: due.length,
			messages,
		});
		await onProgress?.(where(0)).catch(() => {});

		const keep = normalizeKeep(mailbox.settings.autoBackup?.keep);
		try {
			const written = await writeMailboxBackup(
				env,
				mailbox.id,
				now,
				keep,
				onProgress && ((messages) => onProgress(where(messages))),
			);
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
