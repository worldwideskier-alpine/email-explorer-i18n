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
	spamPurge?: { finishedAt: string; ran: number };
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
