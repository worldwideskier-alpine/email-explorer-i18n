/**
 * What the nightly cron actually did, recorded as it goes.
 *
 * Each pass already records its outcome on the mailboxes it touched, and that
 * is enough to answer "did my backup run" -- but not "did the run finish".
 * Those are different questions, and the second one had no answer at all.
 *
 * In production the backup pass recorded a success at 03:00:38 and the spam
 * purge recorded nothing, ever. From the mailbox alone there is no way to tell
 * a run that stopped between the two passes from a run that reached the purge
 * and found nothing to do: both leave exactly the same absence. This is
 * written at the start and again after each pass, so an invocation that ends
 * early leaves a record with a beginning and no end, and says where it got to.
 *
 * One small object for the whole deployment, not one per mailbox: the question
 * is about the run, and a run is a deployment-wide thing.
 */

import type { Env } from "./types";

export const MAINTENANCE_KEY = "maintenance/last-run.json";

export interface MaintenancePhase {
	finishedAt: string;
	considered: number;
	ran: number;
	failed: number;
	/** Messages removed. Only the purge counts these. */
	deleted?: number;
	/** Set when the pass threw instead of finishing. */
	error?: string;
}

/**
 * How far into the backup pass the run had got, written as it goes.
 *
 * `backups` is written whether the pass returns or throws, so its absence
 * means the pass never handed control back at all -- the runtime cut the
 * invocation off inside it. That happened on the live deployment: the record
 * for 2026-09-04 was `{"startedAt":"2026-09-03T18:14:09.407Z"}` and nothing
 * else, no backup was written for either mailbox that night or the two nights
 * before, and the spam purge -- which runs after the backups -- had never once
 * recorded a thing.
 *
 * "It was killed inside the backups" is as far as that record could go. Which
 * mailbox, and how far into it, is the difference between a mailbox that is
 * too large to finish and a pass that never reaches the mailboxes at the back
 * of the list. This is what says which.
 */
export interface MaintenanceProgress {
	mailbox: string;
	/** 1-based position among the mailboxes that were due, and how many. */
	index: number;
	of: number;
	/** Messages written into this mailbox's archive so far. */
	messages: number;
	/** Absent on a record written before this field existed. */
	at?: string;
}

export interface MaintenanceRecord {
	startedAt: string;
	/** Absent means the invocation ended before the run reached its end. */
	finishedAt?: string;
	/** The last thing the backup pass reported; see MaintenanceProgress. */
	backupProgress?: MaintenanceProgress;
	backups?: MaintenancePhase;
	spamPurge?: MaintenancePhase;
}

export async function readMaintenanceRecord(
	env: Pick<Env, "BUCKET">,
): Promise<MaintenanceRecord | null> {
	const stored = await env.BUCKET.get(MAINTENANCE_KEY);
	if (!stored) return null;
	try {
		return await stored.json<MaintenanceRecord>();
	} catch {
		// Unreadable is as good as absent here, and throwing would take down
		// whatever asked -- including the cron that is trying to write it.
		return null;
	}
}

export async function writeMaintenanceRecord(
	env: Pick<Env, "BUCKET">,
	record: MaintenanceRecord,
): Promise<void> {
	await env.BUCKET.put(MAINTENANCE_KEY, JSON.stringify(record));
}

/**
 * The nights before the last one, newest first.
 *
 * The record above is overwritten by every run, which is what made the night
 * of 2026-09-22 unanswerable five days later: it was cut off after fifteen
 * minutes, and the next night's record replaced the only trace of it. Each
 * run therefore moves the previous record in here before it starts its own --
 * including a record that never reached its end, which is the one worth
 * keeping. Two weeks is enough to notice a night that went wrong without
 * having been looking for it.
 */
export const MAINTENANCE_HISTORY_KEY = "maintenance/history.json";
export const HISTORY_LENGTH = 14;

export async function readMaintenanceHistory(
	env: Pick<Env, "BUCKET">,
): Promise<MaintenanceRecord[]> {
	const stored = await env.BUCKET.get(MAINTENANCE_HISTORY_KEY);
	if (!stored) return [];
	try {
		const history = await stored.json<unknown>();
		return Array.isArray(history) ? (history as MaintenanceRecord[]) : [];
	} catch {
		return [];
	}
}

/**
 * Moves the last run's record to the front of the history.
 *
 * Only once per run: a record already at the front (the cron firing twice, or
 * a retry of this step) is not added again.
 */
export async function archiveLastRun(env: Pick<Env, "BUCKET">): Promise<void> {
	const last = await readMaintenanceRecord(env);
	if (!last) return;
	const history = await readMaintenanceHistory(env);
	if (history[0]?.startedAt === last.startedAt) return;
	await env.BUCKET.put(
		MAINTENANCE_HISTORY_KEY,
		JSON.stringify([last, ...history].slice(0, HISTORY_LENGTH)),
	);
}
