/**
 * One mailbox's nightly backup, and what is written down about it.
 *
 * The cron fires once a day for the whole Worker, not once per mailbox; each
 * mailbox's own frequency decides whether its backup is due (see
 * isBackupDue), and each due mailbox runs on its own -- see mailbox-night.ts
 * for where, and why no longer one after another.
 *
 * Every run records what happened on the mailbox, success or failure. A
 * backup that quietly stops working is worse than no backup at all: the
 * mailbox looks protected right up until the day someone needs it. The
 * settings screen shows this, so "it has not run since March" is visible
 * without going to the logs.
 */

import type { AutoBackupSettings } from "./auto-backup";
import { normalizeKeep } from "./auto-backup";
import type { MailboxSource } from "./backup-writer";
import { writeMailboxBackup } from "./backup-writer";
import type { TimeLimits } from "./deadline";
import { OutOfTime, recordingWithin } from "./deadline";
import type { MailboxRecord } from "./mailbox-records";
import { updateMailboxSettings } from "./mailbox-records";
import type { Env } from "./types";

/**
 * Writes the outcome back onto the mailbox. Only the fields this run owns.
 *
 * `lastRunAt` moves only on success. It is what decides the next run is due,
 * and moving it on a failure put a weekly or monthly backup off for the whole
 * interval after one transient error; a failed mailbox is due again the next
 * night.
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

/** How one mailbox's backup went tonight. */
export type BackupOutcome = "ran" | "failed";

/**
 * One mailbox's backup: written, and its outcome recorded on the mailbox,
 * whatever it was.
 *
 * Each mailbox runs on its own, inside its own object's nightly alarm (see
 * mailbox-night.ts). It used to be one turn in a pass over every mailbox,
 * one after another inside one invocation and one deadline -- so a slow
 * mailbox spent the time of the ones behind it, and on 2026-10-01 the second
 * of two was cut off 300 messages in while the first had used the night. Now
 * each has the whole of its own.
 *
 * Never throws: a failure is the outcome, recorded where the mailbox's own
 * screen shows it.
 */
export async function backupOneMailbox(
	env: Env,
	mailbox: MailboxRecord,
	now: Date,
	/** When this backup must be done by, and how long one call may take. */
	limits: TimeLimits = {},
	/** Messages written so far, every few hundred; failures are swallowed. */
	onProgress?: (messages: number) => Promise<void>,
	/** The mailbox's own object, when this runs inside it. */
	source?: MailboxSource,
): Promise<BackupOutcome> {
	// Recording is held to the per-call limit only, up to `recordBy`: refusing
	// to write down how it went because time is up would lose exactly the
	// fact the deadline exists to produce.
	const call = recordingWithin(limits);
	if (onProgress) {
		await call(onProgress(0), "recording progress").catch(() => {});
	}

	const keep = normalizeKeep(mailbox.settings.autoBackup?.keep);
	try {
		const written = await writeMailboxBackup(
			env,
			mailbox.id,
			now,
			keep,
			onProgress,
			undefined,
			limits,
			source,
		);
		// Given the per-call limit alone: the archive is written by now, and
		// saying so should not be refused because the time has just run out.
		// A failure here is not a failed backup either.
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
		return "ran";
	} catch (e) {
		await call(
			recordResult(env, mailbox.id, {
				at: now.toISOString(),
				ok: false,
				error: String(e instanceof Error ? e.message : e).slice(0, 300),
				// Begun, and stopped by its time running out rather than by a
				// fault: worded on the screen in the reader's language.
				...(e instanceof OutOfTime && e.passEnded
					? { reason: "out-of-time" as const }
					: {}),
			}),
			"recording the result",
		).catch(() => {});
		return "failed";
	}
}

/**
 * A mailbox whose backup was due and never began: its night could not be
 * started, or its object never said it had run. Recorded on the mailbox the
 * way any failure is, so its screen does not go on showing the night before.
 */
export async function recordBackupNotRun(
	env: Env,
	mailboxId: string,
	now: Date,
	error: string,
	limits: TimeLimits = {},
): Promise<void> {
	await recordingWithin(limits)(
		recordResult(env, mailboxId, {
			at: now.toISOString(),
			ok: false,
			error: error.slice(0, 300),
		}),
		"recording the result",
	).catch(() => {});
}
