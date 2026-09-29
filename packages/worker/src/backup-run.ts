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
import type { TimeLimits } from "./deadline";
import { pastDeadline, recordingWithin } from "./deadline";
import { listMailboxes, updateMailboxSettings } from "./mailbox-records";
import type { Env } from "./types";

/**
 * Writes the outcome back onto the mailbox. Only the fields this run owns.
 *
 * `lastRunAt` moves only on success. It is what decides the next run is due,
 * and moving it on a failure put a weekly or monthly backup off for the whole
 * interval after one transient error; a failed mailbox is due again the next
 * night. The order of the pass is not taken from it: see mostOverdueFirst.
 */
async function recordResult(
	env: Env,
	mailboxId: string,
	result: NonNullable<AutoBackupSettings["lastResult"]>,
): Promise<void> {
	await updateMailboxSettings(env, mailboxId, (settings) => {
		settings.autoBackup = {
			...settings.autoBackup,
			...(result.ok ? { lastRunAt: result.at } : {}),
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
 * The one whose turn is longest overdue first.
 *
 * The order used to be whatever `listMailboxes` returned, which is fine only
 * while every mailbox gets its turn. When an invocation stops finishing, it
 * stops finishing partway through the list -- so a fixed order means the
 * mailboxes at the front are backed up every night and the ones behind them
 * are never backed up again, silently, while their settings screen goes on
 * showing the last time they were.
 *
 * Sorting by when each last *succeeded* did not fix that; it moved it. A
 * mailbox too big to finish inside the pass keeps its old success time, so it
 * was first again every night, used the whole budget again, and every mailbox
 * behind it was "not reached" for good. So the order is by when each was last
 * *begun*: one that had its turn tonight, however it ended, goes behind one
 * that did not get a turn at all. Ties -- both begun the same night, or
 * neither ever -- go to the one whose last success is older. Never begun and
 * never succeeded sorts first, having waited longest of all; a mailbox from
 * before the attempt was recorded counts from its last success.
 */
function mostOverdueFirst(
	mailboxes: Awaited<ReturnType<typeof listMailboxes>>,
): typeof mailboxes {
	// ISO-8601 UTC sorts correctly as text, and "" sorts before all of it.
	const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
	return [...mailboxes].sort((a, b) => {
		const ab = a.settings.autoBackup;
		const bb = b.settings.autoBackup;
		return (
			byText(
				ab?.lastAttemptAt ?? ab?.lastRunAt ?? "",
				bb?.lastAttemptAt ?? bb?.lastRunAt ?? "",
			) || byText(ab?.lastRunAt ?? "", bb?.lastRunAt ?? "")
		);
	});
}

/**
 * Notes that this mailbox's turn has begun, before anything is written. It
 * goes first because an invocation that is cut off records nothing after it,
 * and a turn that left no trace would put this mailbox at the front again.
 */
async function recordAttempt(
	env: Env,
	mailboxId: string,
	at: string,
): Promise<void> {
	await updateMailboxSettings(env, mailboxId, (settings) => {
		settings.autoBackup = { ...settings.autoBackup, lastAttemptAt: at };
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
	/**
	 * When the pass must be done by, and how long one call may take. A
	 * mailbox not started by the deadline is not started at all tonight: it
	 * is recorded as not reached and, having not moved `lastRunAt`, is first
	 * in line tomorrow. See deadline.ts for the night that made this matter.
	 */
	limits: TimeLimits = {},
): Promise<BackupPassSummary> {
	// Listing, reporting and recording are held to the per-call limit only.
	// The deadline decides which mailboxes are *started*; refusing to write
	// down that one was not reached, because time is up, would lose exactly
	// the fact the deadline exists to produce.
	const call = recordingWithin(limits);
	const mailboxes = await call(listMailboxes(env), "listing mailboxes");
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
		if (pastDeadline(limits)) {
			summary.failed += 1;
			await call(
				recordResult(env, mailbox.id, {
					at: now.toISOString(),
					ok: false,
					error: "Not reached tonight: the pass ran out of time first.",
					// The screen shows this one in the reader's own language; an
					// English sentence written for people was going out as-is
					// in every one of them.
					reason: "not-reached",
				}),
				"recording the result",
			).catch(() => {});
			continue;
		}
		await call(
			recordAttempt(env, mailbox.id, now.toISOString()),
			"recording the attempt",
		).catch(() => {});
		if (onProgress) {
			await call(onProgress(where(0)), "recording progress").catch(() => {});
		}

		const keep = normalizeKeep(mailbox.settings.autoBackup?.keep);
		try {
			const written = await writeMailboxBackup(
				env,
				mailbox.id,
				now,
				keep,
				onProgress && ((messages) => onProgress(where(messages))),
				undefined,
				limits,
			);
			summary.ran += 1;
			// Given the per-call limit alone: the archive is written by now,
			// and saying so should not be refused because the pass's time has
			// just run out. A failure here is not a failed backup either.
			await call(
				recordResult(env, mailbox.id, {
					at: now.toISOString(),
					ok: true,
					messages: written.messages,
					bytes: written.bytes,
					removed: written.removed,
				}),
				"recording the result",
			).catch(() => {});
		} catch (e) {
			// One mailbox failing must not stop the others: they are separate
			// backups and a large mailbox running out of budget should not
			// take a small one down with it.
			summary.failed += 1;
			await call(
				recordResult(env, mailbox.id, {
					at: now.toISOString(),
					ok: false,
					error: String(e instanceof Error ? e.message : e).slice(0, 300),
				}),
				"recording the result",
			).catch(() => {});
		}
	}

	return summary;
}
