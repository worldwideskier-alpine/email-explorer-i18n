/**
 * How the last nightly run went, as the root screen reads it.
 *
 * The record is written at the start and updated after each pass, so what is
 * *missing* from it is the finding. See maintenance-record.ts in the Worker.
 */

export interface MaintenanceProgress {
	mailbox: string;
	/** 1-based position among the mailboxes that were due, and how many. */
	index: number;
	of: number;
	messages: number;
	at: string;
}

export interface MaintenanceRecord {
	startedAt: string;
	finishedAt?: string;
	/**
	 * Where the backup pass had got to. Optional so a screen newer than its
	 * Worker still works -- and the run that made this necessary predates the
	 * field, so it is absent on exactly the record that motivated it.
	 */
	backupProgress?: MaintenanceProgress;
	backups?: { finishedAt: string; ran: number };
	/** `ran` counts mailboxes; `deleted` counts messages. See below. */
	spamPurge?: { finishedAt: string; ran: number; deleted?: number };
}

/**
 * How many messages the purge actually removed.
 *
 * The finished line used to show `spamPurge.ran`, which is the number of
 * *mailboxes* the purge visited, next to the number of mailboxes backed up.
 * Read as "2 spam deleted" it is simply wrong, and the first night the purge
 * ever ran it said "2" while removing 5 messages. The count of messages is
 * what anyone is asking, and it was recorded all along and never shown.
 *
 * Absent on a record written before the field existed, which reads as 0 rather
 * than as a claim that nothing was deleted -- there is no way to tell those
 * apart from such a record, and 0 is the smaller lie.
 */
export function maintenanceDeleted(
	record: MaintenanceRecord | null | undefined,
): number {
	return record?.spamPurge?.deleted ?? 0;
}

/**
 * How long the run took, as `8m42s`.
 *
 * The number that says how close this is to the edge. The run that had been
 * being cut off is now finishing in eight and three quarter minutes, which is
 * not comfortable -- and the only way to see it creeping back up is to have it
 * on the screen, before the day it stops finishing again.
 *
 * Raw and untranslated, like the response marker on the spam check: it is two
 * numbers and two letters, and rendering a duration properly in 73 languages
 * would be a much larger thing than the value it adds here.
 */
export function maintenanceDuration(
	record: MaintenanceRecord | null | undefined,
): string {
	if (!record?.finishedAt) return "";
	const ms = Date.parse(record.finishedAt) - Date.parse(record.startedAt);
	if (!Number.isFinite(ms) || ms < 0) return "";

	const seconds = Math.round(ms / 1000);
	const minutes = Math.floor(seconds / 60);
	return minutes > 0 ? `${minutes}m${seconds % 60}s` : `${seconds}s`;
}

/**
 * Which sentence an unfinished run gets.
 *
 * `backups` is written whether the pass returned or threw, so a run holding
 * progress and no `backups` is one the runtime cut off *inside* the backups.
 * That used to be reported as "it did not reach the spam purge" -- true of it,
 * and equally true of a run that finished the backups and died a step later.
 * Two different faults with two different fixes, told as one sentence, on the
 * one screen that exists to tell them apart.
 *
 * Measured on the live deployment: the record for 2026-09-04 was
 * `{"startedAt":"2026-09-03T18:14:09.407Z"}` and nothing else. No backup had
 * been written for two nights and the spam purge had never once run -- all
 * three symptoms of the same invocation dying in the same place.
 */
export function maintenanceStoppedKey(
	record: MaintenanceRecord | null | undefined,
): string {
	if (record?.spamPurge) return "root.maintenance.unfinished";
	if (record?.backupProgress && !record.backups)
		return "root.maintenance.killedInBackup";
	return "root.maintenance.notReached";
}

/**
 * Which mailbox, where in the pass, and how many messages in.
 *
 * Raw and untranslated on purpose, like the response marker on the spam check:
 * it is an address and three numbers, and none of it is our prose. It is the
 * difference between one mailbox being too large to finish and the pass never
 * reaching the mailboxes at the back of the list.
 */
export function maintenanceStoppedDetail(
	record: MaintenanceRecord | null | undefined,
): string {
	const at = record?.backupProgress;
	if (!at) return "";
	return `${at.mailbox} ${at.index}/${at.of} · ${at.messages}`;
}
