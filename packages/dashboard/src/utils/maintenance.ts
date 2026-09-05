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
	/** `error` is set when the pass threw instead of returning. */
	backups?: { finishedAt: string; ran: number; error?: string };
	/** `ran` counts mailboxes; `deleted` counts messages. See below. */
	spamPurge?: {
		finishedAt: string;
		ran: number;
		deleted?: number;
		error?: string;
	};
}

/**
 * What went wrong in a run that nevertheless reached its end.
 *
 * A pass that throws is not the same as an invocation that is cut off: the run
 * carries on, records the error, and sets `finishedAt`. The spam purge does it
 * explicitly before rethrowing (scheduled-run.ts), and the backup pass by
 * simply continuing to the purge, which then sets it.
 *
 * Either way the screen saw `finishedAt` and said "finished" in calm grey --
 * about a night when the purge had crashed and deleted nothing, while the
 * recorded `error` was shown nowhere and was not even in this file's types.
 * That is the failure this whole screen exists to prevent, on the screen
 * itself. `maintenance-record.test.ts` has held the shape of that record since
 * before anyone looked at what it rendered as.
 *
 * Both passes, not just the purge: a backup pass that throws leaves its own
 * `error` and the run still ends, so it reads as "finished, 0 backed up".
 */
export function maintenanceErrorDetail(
	record: MaintenanceRecord | null | undefined,
): string {
	return [
		record?.backups?.error && `backups: ${record.backups.error}`,
		record?.spamPurge?.error && `spamPurge: ${record.spamPurge.error}`,
	]
		.filter(Boolean)
		.join(" · ");
}

/**
 * Whether the run may be reported as simply done.
 *
 * `finishedAt` alone was the test, and it is set on the failure paths too.
 */
export function maintenanceFinishedCleanly(
	record: MaintenanceRecord | null | undefined,
): boolean {
	return !!record?.finishedAt && !maintenanceErrorDetail(record);
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
/** Shown when the record cannot say how long it took. */
const UNKNOWN_DURATION = "\u2014";

export function maintenanceDuration(
	record: MaintenanceRecord | null | undefined,
): string {
	// A dash rather than nothing: this fills a slot in a sentence that always
	// has one, and an empty string leaves the separator around it dangling --
	// "finished ( / 2 backed up / ...)" -- in all 73 of them.
	if (!record?.finishedAt) return UNKNOWN_DURATION;
	const ms = Date.parse(record.finishedAt) - Date.parse(record.startedAt);
	if (!Number.isFinite(ms) || ms < 0) return UNKNOWN_DURATION;

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
	// First, because a run that threw in the purge has a `spamPurge` too, and
	// would otherwise be reported as one that merely did not finish it.
	if (maintenanceErrorDetail(record))
		return "root.maintenance.finishedWithError";
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
	// A run that failed says what failed; one that was cut off says where it
	// got to. They are the same slot in two different sentences.
	const failed = maintenanceErrorDetail(record);
	if (failed) return failed;

	const at = record?.backupProgress;
	if (!at) return "";
	return `${at.mailbox} ${at.index}/${at.of} · ${at.messages}`;
}
