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
 * Two consequences follow from rotation being count-based, and both are
 * documented rather than defended against here:
 *
 *  - Emptying the mailbox and waiting rotates the good copies out. How long
 *    that takes is frequency times retention -- daily and thirty is a month
 *    of noticing.
 *  - Lowering the retention count would therefore be a delete button with a
 *    delay. It is refused: see mergeMailboxSettings, which lets the count
 *    rise and never fall.
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
 * Which stored backups rotation should remove, given every key currently
 * held for a mailbox and how many to keep.
 *
 * Sorting is by key, which is by timestamp, because that is what the naming
 * buys. Anything beyond the newest `keep` goes.
 */
export function keysToRotate(keys: string[], keep: number): string[] {
	const limit = normalizeKeep(keep);
	return [...keys].sort().slice(0, Math.max(0, keys.length - limit));
}
