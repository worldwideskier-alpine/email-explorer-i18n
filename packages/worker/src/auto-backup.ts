/**
 * Scheduled backups of a mailbox, written to R2 as mbox and rotated by count.
 *
 * What this protects against, and what it does not:
 *
 * There is deliberately no way to delete a backup through this application --
 * no endpoint, no button. Rotation is the only path that removes one. So an
 * attacker who gets an administrator's password here can destroy the mail but
 * not the copies of it, and the mail can be put back. That is the threat this
 * is built for.
 *
 * It is not protection against losing the Cloudflare account: whoever holds
 * that reaches R2 directly, without passing through any of this. The backups
 * live in the same bucket as the mail they copy.
 *
 * Two consequences follow from rotation removing anything:
 *
 *  - Emptying the mailbox and waiting rotates the good copies out. The count
 *    alone made that a month on daily-and-thirty, which is not long enough to
 *    rely on noticing, so a second tier keeps each recent month's newest
 *    archive as well -- see keysToRotate, which explains why that beats
 *    watching for a suspicious drop in size. The window is now a year.
 *  - Lowering the retention count would be a delete button with a delay. It
 *    is refused: see mergeMailboxSettings, which lets the count rise and
 *    never fall. The monthly tier is a constant for the same reason.
 */

export type BackupFrequency = "daily" | "weekly" | "monthly";

export const BACKUP_FREQUENCIES: readonly BackupFrequency[] = [
	"daily",
	"weekly",
	"monthly",
];

/** The smallest and largest number of copies a mailbox may be asked to keep. */
export const MIN_BACKUP_KEEP = 1;
export const MAX_BACKUP_KEEP = 365;

export interface AutoBackupSettings {
	enabled?: boolean;
	frequency?: BackupFrequency;
	keep?: number;
	lastRunAt?: string;
	lastResult?: {
		at: string;
		ok: boolean;
		messages?: number;
		bytes?: number;
		removed?: number;
		error?: string;
	};
}

export function normalizeKeep(value: unknown): number {
	const n = Math.floor(Number(value));
	if (!Number.isFinite(n)) return MIN_BACKUP_KEEP;
	return Math.min(MAX_BACKUP_KEEP, Math.max(MIN_BACKUP_KEEP, n));
}

export function normalizeFrequency(value: unknown): BackupFrequency {
	return BACKUP_FREQUENCIES.includes(value as BackupFrequency)
		? (value as BackupFrequency)
		: "daily";
}

const DAY_MS = 24 * 60 * 60 * 1000;

const INTERVAL_MS: Record<BackupFrequency, number> = {
	daily: DAY_MS,
	weekly: 7 * DAY_MS,
	monthly: 30 * DAY_MS,
};

/**
 * Whether this mailbox is due for a backup.
 *
 * The cron fires once a day for every mailbox; this decides which of them
 * actually get written. A mailbox that has never been backed up is due
 * immediately, so turning the setting on does not mean waiting a month to
 * find out whether it works.
 *
 * The comparison is deliberately a little slack: a daily backup run by a
 * cron that drifts by a few minutes would otherwise skip a day every time it
 * fired early. An hour of slack costs nothing and stops that.
 */
const DUE_SLACK_MS = 60 * 60 * 1000;

export function isBackupDue(
	settings: AutoBackupSettings | undefined,
	now: number,
): boolean {
	if (!settings?.enabled) return false;
	if (!settings.lastRunAt) return true;

	const last = Date.parse(settings.lastRunAt);
	if (Number.isNaN(last)) return true;

	return (
		now - last >=
		INTERVAL_MS[normalizeFrequency(settings.frequency)] - DUE_SLACK_MS
	);
}

/** `backups/<mailbox>/<ISO>.mbox`; ISO sorts lexicographically by time. */
export function backupKeyPrefix(mailboxId: string): string {
	return `backups/${encodeURIComponent(mailboxId)}/`;
}

export function backupKey(mailboxId: string, at: Date): string {
	// Colons are legal in an R2 key but awkward in a URL path and a filename,
	// so the timestamp is written without them.
	const stamp = at.toISOString().replace(/[:.]/g, "-");
	return `${backupKeyPrefix(mailboxId)}${stamp}.mbox`;
}

/**
 * How many months keep an archive of their own, on top of the count.
 *
 * Deliberately a constant and not a setting. Every knob a caller can turn
 * down is a way to delete backups with one cycle's delay, which is the thing
 * this whole feature exists to prevent; `keep` already has to be defended by
 * a rule that it may only rise (see mergeMailboxSettings). A second knob
 * would need the same defence and buy nothing, so there isn't one.
 */
export const MONTHLY_TIERS = 12;

/** `2026-08` out of `backups/box/2026-08-30T18-00-00-000Z.mbox`. */
function monthOf(key: string): string | null {
	const name = key.slice(key.lastIndexOf("/") + 1);
	const match = /^(\d{4}-\d{2})-\d{2}T/.exec(name);
	return match ? match[1] : null;
}

/**
 * Which stored backups rotation should remove, given every key currently held
 * for a mailbox and how many to keep.
 *
 * Two tiers survive, and a key has only to be in one of them:
 *
 *  - the newest `keep`, which is what the mailbox owner asked for;
 *  - the newest archive of each of the most recent MONTHLY_TIERS months.
 *
 * The monthly tier is what answers the hole the count alone leaves. Rotation
 * by count means an attacker holding an administrator's password can empty
 * the mailbox and simply wait: after frequency times retention -- a month, on
 * daily and thirty -- every good archive has been rotated out and replaced by
 * an empty one. A size check on each new archive was the obvious guard and is
 * a poor one: it fires on a legitimate clear-out, needs a threshold nobody
 * can pick correctly, and is defeated by deleting slowly enough that no
 * single run looks unusual.
 *
 * Keeping a month's newest costs at most MONTHLY_TIERS extra archives, has no
 * threshold to tune, cannot be walked past by deleting gradually, and never
 * fires on anything -- there is no judgement in it to get wrong. It turns the
 * window in which the loss is noticeable and reversible from a month into a
 * year.
 *
 * Sorting is by key, which is by timestamp, because that is what the naming
 * buys. Anything whose timestamp cannot be read is kept: an unrecognized key
 * in a backup bucket is not something to delete on a guess.
 */
export function keysToRotate(keys: string[], keep: number): string[] {
	const limit = normalizeKeep(keep);
	const sorted = [...keys].sort();

	const protectedKeys = new Set(
		sorted.slice(Math.max(0, sorted.length - limit)),
	);

	// Ascending order means the last key seen for a month is that month's
	// newest, and the last MONTHLY_TIERS months are the most recent ones.
	const newestOfMonth = new Map<string, string>();
	for (const key of sorted) {
		const month = monthOf(key);
		if (month === null) protectedKeys.add(key);
		else newestOfMonth.set(month, key);
	}
	for (const key of [...newestOfMonth.values()].slice(-MONTHLY_TIERS)) {
		protectedKeys.add(key);
	}

	return sorted.filter((key) => !protectedKeys.has(key));
}
