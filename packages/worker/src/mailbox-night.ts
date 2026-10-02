/**
 * One mailbox's night: its backup, then its spam purge, in that order.
 *
 * Every mailbox used to be one turn in a single pass, one after another
 * inside the cron's one invocation and one deadline -- so a slow mailbox
 * spent the time of the ones behind it. On 2026-10-01 the second of two was
 * cut off 300 messages in: work that took 3.5 to 8.5 minutes on the nights
 * before, on a night the first had been slow. Now each mailbox's night runs
 * in its own Durable Object's alarm, all of them at once, each with the whole
 * of its own time; the cron starts them and writes down how they went (see
 * scheduled-run.ts).
 *
 * The order inside a mailbox is the one that makes the purge safe to offer:
 * the backup first, so a message the purge removes tonight is already in
 * tonight's archive. It is the purge's own rule, too -- for a mailbox with
 * backups on it deletes only what an archive in the bucket holds -- so the
 * order is kept twice over.
 */

import { isBackupDue } from "./auto-backup";
import { backupOneMailbox, recordBackupNotRun } from "./backup-run";
import type { MailboxSource } from "./backup-writer";
import {
	abandonPausedBackup,
	SLICE_BYTES,
	SLICE_WALL_MS,
} from "./backup-writer";
import type { MailboxRecord } from "./mailbox-records";
import { foldContinuedNight } from "./maintenance-record";
import { purgeOneMailbox } from "./spam-purge-run";
import type { Env } from "./types";

/**
 * How long a mailbox's night may take, from when it starts.
 *
 * An alarm is ended by the runtime at fifteen minutes of wall time, as the
 * cron is, and says nothing when it is. So the backup must be done twelve
 * minutes in and the purge by thirteen, and writing down how it went stops at
 * thirteen and a half -- inside the cron's own wait for it.
 *
 * CPU is the other limit: an alarm has 30 seconds of it, where the cron that
 * built the archive before had fifteen minutes. Neither limit is left for a
 * growing mailbox to reach one night: the backup is written in slices that
 * pause and carry on in the next alarm (SLICE_BYTES, backup-writer.ts), so
 * each alarm does a bounded amount whatever the mailbox weighs. Raising the
 * CPU limit instead (`limits.cpu_ms`) would raise it for every request this
 * Worker serves, and only move the night on which it ran out.
 */
export const NIGHT_BACKUP_BY_MS = 12 * 60_000;
export const NIGHT_PURGE_BY_MS = 13 * 60_000;
export const NIGHT_RECORD_BY_MS = 13.5 * 60_000;

/**
 * How far a backup may be carried from alarm to alarm before it is given up.
 *
 * A slice is at most 128 MiB (SLICE_BYTES), so this is a mailbox of several
 * gigabytes -- and the night must end long before the next one starts, which
 * would otherwise begin the same archive over the top of it.
 */
export const MAX_SLICES = 100;
export const NIGHT_LONGEST_MS = 20 * 60 * 60_000;

export interface NightLimits {
	backupByMs?: number;
	purgeByMs?: number;
	recordByMs?: number;
	/** Absent means CALL_LIMIT_MS. Tests pass a small one. */
	callLimitMs?: number;
	/** Where a backup slice stops; see SLICE_BYTES. Tests pass small ones. */
	sliceBytes?: number;
	sliceWallMs?: number;
	maxSlices?: number;
}

/** Where one part of a mailbox's night is. */
export type NightPart = "skipped" | "waiting" | "running" | "ran" | "failed";

/** A mailbox's night as it goes, for the cron to read and write down. */
export interface NightStatus {
	/** The run it belongs to: the moment the cron began, as ISO-8601. */
	night: string;
	mailbox: string;
	/**
	 * `continuing`: a slice of the backup has paused, and the next alarm
	 * carries on with it. `running` found on waking means the runtime ended
	 * the last one partway; see cutOff.
	 */
	state: "scheduled" | "running" | "continuing" | "done";
	backup: {
		state: NightPart;
		/** Messages written into the archive so far, and when that was said. */
		messages?: number;
		at?: string;
		/** How many slices the backup has taken, this one included. */
		slices?: number;
	};
	purge: { state: NightPart; deleted?: number };
}

/** What tonight holds for this mailbox, before any of it has begun. */
export function nightFor(mailbox: MailboxRecord, now: Date): NightStatus {
	return {
		night: now.toISOString(),
		mailbox: mailbox.id,
		state: "scheduled",
		backup: {
			state: isBackupDue(mailbox.settings.autoBackup, now.getTime())
				? "waiting"
				: "skipped",
		},
		purge: {
			state: mailbox.settings.spamRetention?.enabled ? "waiting" : "skipped",
		},
	};
}

/** Whether the night has anything to do at all. */
export function nightHasWork(status: NightStatus): boolean {
	return status.backup.state !== "skipped" || status.purge.state !== "skipped";
}

/** Whether a part has come to its end, one way or the other. */
export function partSettled(state: NightPart): boolean {
	return state === "skipped" || state === "ran" || state === "failed";
}

/**
 * Runs one mailbox's night -- or, with `from`, carries on with one whose
 * backup paused -- and says how it goes at every step.
 *
 * `report` is handed a copy of the status each time it moves: before each
 * part, every few hundred messages of the backup, after each part and at the
 * end. Its failures are swallowed -- a diagnostic that can stop the backup is
 * worse than none -- and nothing here throws: each part records its own
 * failure on the mailbox and the night goes on.
 *
 * A night whose backup pauses returns `continuing`, and whoever runs it runs
 * it again with that status: the next alarm, in production. Every limit runs
 * from the start of the slice in hand, so each alarm has the whole of its own.
 */
export async function runMailboxNight(
	env: Env,
	mailbox: MailboxRecord,
	now: Date,
	limits: NightLimits,
	report: (status: NightStatus) => Promise<void>,
	/** The mailbox's own object, when this runs inside it. */
	source?: MailboxSource,
	/** The night to carry on with, when its backup paused. */
	from?: NightStatus,
): Promise<NightStatus> {
	const start = Date.now();
	const backupBy = start + (limits.backupByMs ?? NIGHT_BACKUP_BY_MS);
	const purgeBy = start + (limits.purgeByMs ?? NIGHT_PURGE_BY_MS);
	const recordBy = start + (limits.recordByMs ?? NIGHT_RECORD_BY_MS);

	const status: NightStatus = from
		? structuredClone(from)
		: nightFor(mailbox, now);
	const resuming = status.backup.state === "running";
	status.state = "running";
	const say = () => report(structuredClone(status)).catch(() => {});
	await say();

	if (status.backup.state === "waiting" || resuming) {
		const slices = (status.backup.slices ?? 0) + 1;
		if (
			resuming &&
			(slices > (limits.maxSlices ?? MAX_SLICES) ||
				start - Date.parse(status.night) > NIGHT_LONGEST_MS)
		) {
			await abandonPausedBackup(env, mailbox.id).catch(() => {});
			await recordBackupNotRun(
				env,
				mailbox.id,
				now,
				`Not finished in ${slices - 1} parts before the next night; given up.`,
			);
			status.backup.state = "failed";
			await say();
		} else {
			status.backup.state = "running";
			status.backup.slices = slices;
			await say();
			const outcome = await backupOneMailbox(
				env,
				mailbox,
				now,
				{
					deadline: backupBy,
					callLimitMs: limits.callLimitMs,
					recordBy: purgeBy,
				},
				async (messages) => {
					status.backup.messages = messages;
					status.backup.at = new Date().toISOString();
					await say();
				},
				source,
				{
					bytes: limits.sliceBytes ?? SLICE_BYTES,
					until: start + (limits.sliceWallMs ?? SLICE_WALL_MS),
					resume: resuming,
				},
			);
			if (outcome === "paused") {
				status.state = "continuing";
				await say();
				return status;
			}
			status.backup.state = outcome;
			await say();
		}
	}

	if (status.purge.state === "waiting") {
		status.purge.state = "running";
		await say();
		const purged = await purgeOneMailbox(
			env,
			mailbox,
			now,
			{ deadline: purgeBy, callLimitMs: limits.callLimitMs, recordBy },
			source,
		);
		status.purge = {
			state: purged.ok ? "ran" : "failed",
			deleted: purged.deleted,
		};
		await say();
	}

	status.state = "done";
	await say();
	// Carried past the cron's wait, the night's outcome is not in the run's
	// record yet; it goes in now. A night the cron saw end is already there.
	if (from) await foldContinuedNight(env, status).catch(() => {});
	return status;
}

/**
 * The night of a mailbox whose alarm was ended by the runtime partway.
 *
 * The runtime runs an alarm again when it did not finish, and running the
 * whole night again would most likely end the same way, as many times as it
 * is retried. So the second attempt finishes the record instead: whatever was
 * under way or still waiting is counted as failed, and the mailbox is due
 * again tomorrow, as any failed backup is.
 */
export function cutOff(status: NightStatus): NightStatus {
	const failIfOpen = (state: NightPart): NightPart =>
		partSettled(state) ? state : "failed";
	return {
		...status,
		state: "done",
		backup: { ...status.backup, state: failIfOpen(status.backup.state) },
		purge: { ...status.purge, state: failIfOpen(status.purge.state) },
	};
}

/** How the cron starts mailboxes' nights and asks how they are going. */
export interface NightRunner {
	start(mailbox: MailboxRecord, now: Date): Promise<void>;
	status(mailboxId: string, now: Date): Promise<NightStatus | null>;
}

/**
 * Each mailbox's night in its own object's alarm: what the scheduled
 * handler uses.
 */
export function alarmNights(env: Env): NightRunner {
	const stub = (id: string) => env.MAILBOX.get(env.MAILBOX.idFromName(id));
	return {
		start: async (mailbox, now) => {
			await stub(mailbox.id).startNight(mailbox, now.toISOString());
		},
		status: async (id, now) =>
			(await stub(id).nightStatus(now.toISOString())) as NightStatus | null,
	};
}

/**
 * The same nights run here, with this `env`, all at once.
 *
 * What a test needs when it hands the run an `env` of its own -- a bucket
 * that fails, a mailbox that never answers -- since an alarm runs inside the
 * mailbox's object with the deployment's own. The night is the same code
 * either way; only where it runs differs.
 */
export function inlineNights(env: Env, limits: NightLimits = {}): NightRunner {
	const statuses = new Map<string, NightStatus>();
	return {
		start: async (mailbox, now) => {
			statuses.set(mailbox.id, nightFor(mailbox, now));
			const keep = async (status: NightStatus) => {
				statuses.set(mailbox.id, status);
			};
			// Each slice after the last, as the next alarm would run it.
			void (async () => {
				let status = await runMailboxNight(env, mailbox, now, limits, keep);
				while (status.state === "continuing") {
					status = await runMailboxNight(
						env,
						mailbox,
						now,
						limits,
						keep,
						undefined,
						status,
					);
				}
			})();
		},
		status: async (id) => statuses.get(id) ?? null,
	};
}
