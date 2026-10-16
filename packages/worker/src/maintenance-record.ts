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

import type { NightStatus } from "./mailbox-night";
import { rewriteJson } from "./r2-json";
import { getBytes } from "./r2-retry";
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
	/**
	 * Why mailboxes failed, each reason once and a few at most. A mailbox's
	 * own record keeps only its latest night, so the reason for 2026-10-07
	 * was gone by the time anybody asked; the history keeps these two weeks.
	 */
	reasons?: string[];
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
	/**
	 * Mailbox deletions root left unfinished, finished tonight and still left.
	 * `left: -1` with an error: the list itself could not be read.
	 */
	unfinishedDeletions?: { finished: number; left: number; error?: string };
	/**
	 * Mailboxes whose night was still carrying its backup from alarm to alarm
	 * when the cron stopped waiting (see SLICE_BYTES). They are in neither
	 * pass's counts yet; each is folded in as its night ends
	 * (foldContinuedNight). `backup` is false for one whose backup had ended
	 * and was counted, and whose purge carried on.
	 */
	continuing?: { mailbox: string; backup: boolean }[];
	/**
	 * The call that runs this night and alone writes this record; see
	 * claimNight. Absent on a record from before there was one.
	 */
	owner?: string;
	/**
	 * Every scheduled call for this firing, as the runtime gave it and as it
	 * began. On 2026-10-13 there were two, 7.4 s apart, and nothing but two
	 * different start times said so; this says so whatever the times.
	 */
	calls?: MaintenanceCall[];
}

export interface MaintenanceCall {
	/** `scheduledTime` as the runtime handed it over. */
	scheduledTime: string;
	/** When the call began. */
	at: string;
	/** Left the night to the call that owns it. */
	stoodAside?: boolean;
}

export async function readMaintenanceRecord(
	env: Pick<Env, "BUCKET">,
): Promise<MaintenanceRecord | null> {
	const stored = await getBytes(env.BUCKET, MAINTENANCE_KEY);
	if (!stored) return null;
	try {
		return JSON.parse(new TextDecoder().decode(stored)) as MaintenanceRecord;
	} catch {
		// Unreadable is as good as absent here, and throwing would take down
		// whatever asked -- including the cron that is trying to write it.
		return null;
	}
}

/**
 * Makes this call the one that runs tonight, or says another call already is.
 *
 * The runtime can call the scheduled handler more than once for one firing:
 * on 2026-10-13 two calls came 7.4 s apart, each began the night, and each
 * wrote this record over the other's. One call per firing runs the night and
 * writes the record; any other leaves at once. Decided by a conditional put,
 * so two calls at the same moment cannot both win.
 *
 * Tonight's record held by another call is left to it -- unless that call
 * reached its end with a pass that threw (the mailboxes could not even be
 * listed): then nothing of the night was begun, and this call, most likely
 * the runtime trying the firing again, takes it over and runs it.
 *
 * Answers whether this call owns the night. A call that cannot tell -- the
 * bucket did not answer -- runs the night all the same: the record is a
 * diagnostic, and a night not run for want of it is the worse loss. Its writes
 * are still refused where another call owns the record.
 */
export async function claimNight(
	env: Pick<Env, "BUCKET">,
	startedAt: string,
	owner: string,
	call: MaintenanceCall,
): Promise<boolean> {
	let claimed = false;
	await rewriteJson<MaintenanceRecord>(
		env.BUCKET,
		MAINTENANCE_KEY,
		(stored) => {
			const tonight = stored?.startedAt === startedAt ? stored : null;
			const threw =
				!!tonight?.finishedAt &&
				!!(tonight.backups?.error || tonight.spamPurge?.error);
			claimed = !tonight || threw;
			const calls = [
				...(tonight?.calls ?? []),
				claimed ? call : { ...call, stoodAside: true },
			];
			return claimed
				? { startedAt, owner, calls }
				: { ...(tonight as MaintenanceRecord), calls };
		},
		{ replaceUnreadable: true },
	);
	return claimed;
}

/**
 * Writes the cron's record over what is stored -- keeping what the nights it
 * stopped waiting for have folded in since, which the cron's own copy does
 * not know about, and the calls other than this one.
 *
 * Only the call that owns the night writes it (see claimNight), and a night's
 * record never replaces a later night's.
 */
export async function writeMaintenanceRecord(
	env: Pick<Env, "BUCKET">,
	record: MaintenanceRecord,
): Promise<void> {
	await rewriteJson<MaintenanceRecord>(
		env.BUCKET,
		MAINTENANCE_KEY,
		(stored) => {
			if (stored && stored.startedAt > record.startedAt) return undefined;
			if (stored?.startedAt !== record.startedAt) return record;
			if (stored.owner && record.owner && stored.owner !== record.owner) {
				return undefined;
			}
			const calls = stored.calls ?? record.calls;
			return stored.continuing && record.continuing
				? {
						...record,
						backups: stored.backups,
						spamPurge: stored.spamPurge,
						continuing: stored.continuing,
						...(calls ? { calls } : {}),
					}
				: { ...record, ...(calls ? { calls } : {}) };
		},
		{ replaceUnreadable: true },
	);
}

/**
 * Adds a night that ended after the cron stopped waiting for it to the run's
 * counts. Only a night the record lists as continuing: one the cron saw end
 * is counted already, and the list is how that is told apart -- so it is
 * counted once, by whichever of the two gets there first.
 */
export async function foldContinuedNight(
	env: Pick<Env, "BUCKET">,
	night: NightStatus,
): Promise<void> {
	await rewriteJson<MaintenanceRecord>(
		env.BUCKET,
		MAINTENANCE_KEY,
		(stored) => {
			const listed = stored?.continuing?.find(
				(entry) => entry.mailbox === night.mailbox,
			);
			if (!stored || stored.startedAt !== night.night || !listed) {
				return undefined;
			}
			const counted = (state: string) =>
				state === "ran"
					? { ran: 1, failed: 0 }
					: state === "skipped"
						? { ran: 0, failed: 0 }
						: { ran: 0, failed: 1 };
			const at = new Date().toISOString();
			const backup = listed.backup
				? counted(night.backup.state)
				: { ran: 0, failed: 0 };
			const purge = counted(night.purge.state);
			const reasons = withReason(
				stored.backups?.reasons,
				listed.backup ? night.backup.error : undefined,
			);
			const purgeReasons = withReason(
				stored.spamPurge?.reasons,
				night.purge.error,
			);
			const backups = stored.backups ?? {
				finishedAt: at,
				considered: 0,
				ran: 0,
				failed: 0,
			};
			const spamPurge = stored.spamPurge ?? {
				finishedAt: at,
				considered: 0,
				ran: 0,
				failed: 0,
				deleted: 0,
			};
			return {
				...stored,
				backups: {
					...backups,
					finishedAt: at,
					ran: backups.ran + backup.ran,
					failed: backups.failed + backup.failed,
					...(reasons ? { reasons } : {}),
				},
				spamPurge: {
					...spamPurge,
					finishedAt: at,
					ran: spamPurge.ran + purge.ran,
					failed: spamPurge.failed + purge.failed,
					deleted: (spamPurge.deleted ?? 0) + (night.purge.deleted ?? 0),
					...(purgeReasons ? { reasons: purgeReasons } : {}),
				},
				continuing: (stored.continuing ?? []).filter(
					(entry) => entry.mailbox !== night.mailbox,
				),
			};
		},
	);
}

/** A failure's reason added to those already kept: once each, three at most. */
export function withReason(
	reasons: string[] | undefined,
	reason: string | undefined,
): string[] | undefined {
	if (!reason || reasons?.includes(reason)) return reasons;
	return [...(reasons ?? []), reason].slice(0, 3);
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
	const stored = await getBytes(env.BUCKET, MAINTENANCE_HISTORY_KEY);
	if (!stored) return [];
	try {
		const history = JSON.parse(new TextDecoder().decode(stored));
		return Array.isArray(history) ? (history as MaintenanceRecord[]) : [];
	} catch {
		return [];
	}
}

/**
 * Moves the last run's record to the front of the history.
 *
 * Only once per run: a record already at the front (the cron firing twice, or
 * a retry of this step) is not added again, and tonight's own -- put by
 * another call for the same firing -- is not added at all.
 *
 * Written conditionally, onto what was read: the put used to be blind, onto
 * a read that answered "none" when it failed, so one failed read would have
 * put a history of one night over fourteen. Now a read that fails throws, and
 * only a history that will not parse at all is started again.
 */
export async function archiveLastRun(
	env: Pick<Env, "BUCKET">,
	tonight?: string,
): Promise<void> {
	const last = await readMaintenanceRecord(env);
	if (!last || last.startedAt === tonight) return;
	await rewriteJson<MaintenanceRecord[]>(
		env.BUCKET,
		MAINTENANCE_HISTORY_KEY,
		(stored) => {
			const history = Array.isArray(stored) ? stored : [];
			if (history[0]?.startedAt === last.startedAt) return undefined;
			return [last, ...history].slice(0, HISTORY_LENGTH);
		},
		{ replaceUnreadable: true },
	);
}
