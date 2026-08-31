/**
 * Deleting old mail out of the spam folder on a schedule.
 *
 * The spam folder is the one place in this mailbox where nothing is ever
 * looked at again: mail arrives there, and unless someone corrects the verdict
 * within a few days it sits there for good, paying for storage and making the
 * folder useless to scan. So it is emptied from the back.
 *
 * Two properties this is built around, both of which are why the deletion is
 * safe to make permanent rather than a move to the trash (which would only
 * move the problem into another folder nobody empties):
 *
 *  - The scheduled pass runs the backup first and this second, so anything
 *    deleted tonight is already inside tonight's archive. A message removed
 *    here is recoverable from a backup for as long as that archive is kept --
 *    see runScheduledMaintenance for the ordering, which is not incidental.
 *  - Nothing is deleted on a guess. A message whose stored date cannot be
 *    read is kept, every time, rather than being treated as infinitely old.
 *
 * Unlike the backup retention count, the number of days may be lowered freely.
 * The rule guarding the backup count exists because rotation is the only thing
 * that deletes an archive, so lowering it would be a delete button with a
 * night's delay against the last copy of the mail. That reasoning does not
 * carry over: what this deletes is spam, and the backups still hold it.
 */

export interface SpamRetentionSettings {
	enabled?: boolean;
	days?: number;
	lastRunAt?: string;
	lastResult?: {
		at: string;
		ok: boolean;
		deleted?: number;
		error?: string;
	};
}

/**
 * The shortest and longest retention a mailbox may be set to.
 *
 * One day is the floor rather than zero: "delete everything in the spam
 * folder every night" is not a retention policy, it is a way to lose a
 * message misfiled that morning before anyone has been at their desk.
 */
export const MIN_SPAM_RETENTION_DAYS = 1;
export const MAX_SPAM_RETENTION_DAYS = 365;
export const DEFAULT_SPAM_RETENTION_DAYS = 30;

export function normalizeRetentionDays(value: unknown): number {
	// Rejected before the conversion, not after it. `Number(null)`,
	// `Number("")` and `Number([])` are all 0, which is finite, and clamping 0
	// gives one day -- so a browser that sent a cleared number field, or a
	// stored setting with no days in it at all, would quietly mean "delete
	// everything in the spam folder older than yesterday". An unreadable value
	// has to fall back to the default, which is the direction that keeps mail.
	if (typeof value !== "number" && typeof value !== "string") {
		return DEFAULT_SPAM_RETENTION_DAYS;
	}
	if (typeof value === "string" && value.trim() === "") {
		return DEFAULT_SPAM_RETENTION_DAYS;
	}

	const n = Math.floor(Number(value));
	if (!Number.isFinite(n)) return DEFAULT_SPAM_RETENTION_DAYS;
	return Math.min(
		MAX_SPAM_RETENTION_DAYS,
		Math.max(MIN_SPAM_RETENTION_DAYS, n),
	);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The moment before which a spam message is old enough to remove. */
export function retentionCutoff(days: unknown, now: number): number {
	return now - normalizeRetentionDays(days) * DAY_MS;
}

export interface DatedEmail {
	id: string;
	date: string | null;
}

/**
 * Which of the spam folder's messages are past the cutoff.
 *
 * The dates are parsed rather than compared as text. Most of them are ISO
 * timestamps in UTC, written when the message arrived, and those would sort
 * correctly as strings -- but an imported message carries whatever its own
 * Date header said, which may be an offset like +09:00 or a format that
 * sorts nowhere near where it belongs. Sorting those as text would delete
 * the wrong messages, and one wrong deletion is worse than the whole feature
 * is worth.
 *
 * A date that cannot be read leaves the message alone. That errs towards
 * keeping spam forever, which costs storage; the other way round costs mail.
 */
export function expiredSpamIds(
	emails: readonly DatedEmail[],
	cutoff: number,
): string[] {
	const out: string[] = [];
	for (const email of emails) {
		if (!email.date) continue;
		const at = Date.parse(email.date);
		if (!Number.isFinite(at)) continue;
		if (at < cutoff) out.push(email.id);
	}
	return out;
}
