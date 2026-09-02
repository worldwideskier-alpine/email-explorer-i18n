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

export interface MaintenanceRecord {
	startedAt: string;
	/** Absent means the invocation ended before the run reached its end. */
	finishedAt?: string;
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
