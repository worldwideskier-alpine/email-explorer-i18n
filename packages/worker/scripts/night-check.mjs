/**
 * Whether last night's run ended well, read from what it left in the bucket.
 *
 * Every way the nightly run has failed so far was found by somebody reading
 * R2 by hand, days later: a run cut off inside the backups for two nights in
 * a row, a run that waited fourteen minutes on one call, a record the next
 * night overwrote before anyone had looked. `/root` says all of it -- to
 * somebody who opens `/root`. Nobody should have to remember to. So a
 * scheduled workflow asks every evening, after the run, and fails when the
 * answer is not "ended well"; a failed scheduled run is mailed to the
 * repository's owner by GitHub.
 *
 * No `node:` imports and no network here, so the judgement is tested in the
 * Workers pool; the reading lives in check-night.mjs, the split
 * deployment-check.mjs uses. Nothing it says names a mailbox: this goes into
 * a public log, and a mailbox's id is its address.
 */

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/**
 * How long a run is given before a record with no end means it was cut off.
 * The cron waits up to fourteen minutes for the nights it starts and then
 * writes its end; a minute or two over that is still the run writing.
 */
export const RUN_GRACE_MS = 16 * MINUTE_MS;

/**
 * What is wrong with the night, and whether it is still too early to say.
 *
 * `pending` is a reason to ask again in a minute rather than an answer: a run
 * still inside its fourteen minutes, or a mailbox whose backup is still being
 * carried from alarm to alarm. The caller asks again until it runs out of
 * patience, and then reports `pending` as the trouble it has become.
 *
 * @param {any} record maintenance/last-run.json, or null when there is none
 * @param {string[]} carried the keys under backup-carry/
 * @param {Date} now
 * @returns {{ trouble: string[], pending?: string }}
 */
export function judgeNight(record, carried, now) {
	if (!record) return { trouble: ["there is no record of any nightly run"] };
	const started = Date.parse(record.startedAt);
	if (Number.isNaN(started)) {
		return { trouble: ["the run's record says no time it started"] };
	}
	const age = now.getTime() - started;
	// The check runs half an hour after the cron, so a record more than a day
	// old is yesterday's: tonight's run never started -- the cron did not
	// fire, or the Worker that has it was not the one deployed.
	if (age > DAY_MS) {
		return {
			trouble: [
				`no run has started in the last 24 hours; the last one started at ${record.startedAt}`,
			],
		};
	}
	if (!record.finishedAt) {
		if (age < RUN_GRACE_MS) {
			return { trouble: [], pending: "the run has not reached its end yet" };
		}
		return { trouble: [cutOff(record)] };
	}
	const continuing = record.continuing ?? [];
	if (continuing.length > 0) {
		return {
			trouble: [],
			pending: `${continuing.length} mailbox(es) still carrying their night from alarm to alarm`,
		};
	}

	const trouble = [];
	for (const [name, phase] of [
		["backups", record.backups],
		["spam purge", record.spamPurge],
	]) {
		if (!phase) trouble.push(`${name}: the run recorded nothing`);
		else if (phase.error) trouble.push(`${name}: ${phase.error}`);
		else if (phase.failed > 0) {
			trouble.push(
				`${name}: ${phase.failed} of ${phase.considered} mailbox(es) failed`,
			);
		}
	}
	const deletions = record.unfinishedDeletions;
	if (!deletions) {
		trouble.push("unfinished deletions: the run recorded nothing");
	} else if (deletions.error || deletions.left < 0) {
		trouble.push(
			`unfinished deletions: ${deletions.error ?? "could not be read"}`,
		);
	} else if (deletions.left > 0) {
		trouble.push(
			`unfinished deletions: ${deletions.left} mailbox deletion(s) still not finished`,
		);
	}
	// A paused backup keeps its place in backup-carry/ only while its night
	// carries on, and none is carrying on. What is left there is an upload
	// nothing will finish, and bytes nothing will remove.
	if (carried.length > 0) {
		trouble.push(
			`${carried.length} object(s) of a paused backup left behind with no night carrying it on`,
		);
	}
	return { trouble };
}

/** Where a run that never wrote its end had got to. */
function cutOff(record) {
	const progress = record.backupProgress;
	const where = !record.backups
		? progress
			? `inside the backups, on mailbox ${progress.index} of ${progress.of} with ${progress.messages} message(s) written`
			: "inside the backups, before any mailbox reported"
		: !record.spamPurge
			? "after the backups, before the spam purge recorded anything"
			: "after both passes, before the unfinished deletions";
	return `the run started at ${record.startedAt} and never reached its end: it was cut off ${where}`;
}

/** One line saying what the night did, naming no mailbox. */
export function nightSummary(record) {
	if (!record) return "no record";
	const phase = (name, p) =>
		p
			? `${name} ${p.ran} ran, ${p.failed} failed of ${p.considered}${
					p.deleted !== undefined ? `, ${p.deleted} message(s) removed` : ""
				}`
			: `${name} not recorded`;
	const deletions = record.unfinishedDeletions;
	return [
		`started ${record.startedAt}`,
		record.finishedAt ? `finished ${record.finishedAt}` : "no end recorded",
		phase("backups", record.backups),
		phase("spam purge", record.spamPurge),
		deletions
			? `unfinished deletions ${deletions.finished} finished, ${deletions.left} left`
			: "unfinished deletions not recorded",
	].join("; ");
}
