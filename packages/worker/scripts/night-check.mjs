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
 * A run whose own call ended before writing its end -- as on 2026-10-25,
 * two minutes in, with both mailboxes' archives written -- is judged by what
 * its nights wrote of themselves (nightsEnded). Its own last duty, finishing
 * deletions left unfinished, was not done: that is trouble only when one is
 * waiting (`deletionsLeft`), and the call's end missing is a `note`.
 *
 * @param {any} record maintenance/last-run.json, or null when there is none
 * @param {string[]} carried the keys under backup-carry/
 * @param {Date} now
 * @param {number} [deletionsLeft] mailbox deletions waiting in
 *   maintenance/unfinished-deletions.json; absent when it was not read
 * @returns {{ trouble: string[], pending?: string, notes?: string[] }}
 */
export function judgeNight(record, carried, now, deletionsLeft) {
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
		const ended = nightsEnded(record);
		if (!ended) return { trouble: [cutOff(record)] };
		if (ended.open > 0) {
			return {
				trouble: [],
				pending: `${ended.open} of ${ended.considered} mailbox night(s) not ended yet, in a run whose own call never wrote its end`,
			};
		}
		const trouble = passTrouble(ended.backups, ended.spamPurge);
		if (deletionsLeft === undefined) {
			trouble.push(
				"unfinished deletions: the run ended before it reached them, and how many wait was not read",
			);
		} else if (deletionsLeft > 0) {
			trouble.push(
				`unfinished deletions: ${deletionsLeft} mailbox deletion(s) still not finished; the run ended before it reached them`,
			);
		}
		if (carried.length > 0) trouble.push(carriedTrouble(carried));
		return {
			trouble,
			notes: [
				`the run's own call ended before writing its end; all ${ended.considered} mailbox night(s) it began wrote theirs`,
			],
		};
	}
	const continuing = record.continuing ?? [];
	if (continuing.length > 0) {
		return {
			trouble: [],
			pending: `${continuing.length} mailbox(es) still carrying their night from alarm to alarm`,
		};
	}

	const trouble = passTrouble(record.backups, record.spamPurge);
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
	if (carried.length > 0) trouble.push(carriedTrouble(carried));
	return { trouble };
}

function passTrouble(backups, spamPurge) {
	const trouble = [];
	for (const [name, phase] of [
		["backups", backups],
		["spam purge", spamPurge],
	]) {
		if (!phase) trouble.push(`${name}: the run recorded nothing`);
		else if (phase.error) trouble.push(`${name}: ${phase.error}`);
		else if (phase.failed > 0) {
			trouble.push(
				`${name}: ${phase.failed} of ${phase.considered} mailbox(es) failed`,
			);
		}
	}
	return trouble;
}

function carriedTrouble(carried) {
	return `${carried.length} object(s) of a paused backup left behind with no night carrying it on`;
}

/**
 * The run's two passes as its nights wrote them, for a run whose own call
 * never wrote its end: each mailbox's night writes how it ended beside the
 * list of nights the call began (`appointed`, `nights`), whatever became of
 * the call. Undefined for a record without that list -- one from before it,
 * or a call that ended before it had begun every night -- which says no more
 * than where the call got to.
 *
 * Failures are counted as the call counts them, by number and never by
 * mailbox; reasons are left out, as in the record's own passes here.
 */
export function nightsEnded(record) {
	if (!Array.isArray(record?.appointed)) return undefined;
	const nights = record.nights ?? {};
	const ended = record.appointed.map((id) => nights[id]).filter(Boolean);
	const settled = (state) => state === "ran" || state === "skipped";
	const pass = (part) => ({
		considered: record.appointed.length,
		ran: ended.filter((night) => night[part]?.state === "ran").length,
		failed: ended.filter((night) => !settled(night[part]?.state)).length,
	});
	return {
		considered: record.appointed.length,
		open: record.appointed.length - ended.length,
		backups: pass("backup"),
		spamPurge: {
			...pass("purge"),
			deleted: ended.reduce(
				(sum, night) => sum + (night.purge?.deleted ?? 0),
				0,
			),
		},
	};
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

/**
 * JSON.parse whose failure names the object and not its bytes: Node quotes
 * the text around the fault, every object read here holds mailbox
 * addresses, and this log is public.
 *
 * @param {string} text
 * @param {string} what
 */
export function parseQuietly(text, what) {
	try {
		return JSON.parse(text);
	} catch {
		throw new Error(`${what} did not parse`);
	}
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
	// Times only, and how many calls: on 2026-10-13 the runtime called the
	// cron twice for one firing, and only two start times said so. Whether
	// `scheduledTime` is the minute scheduled or the moment of delivery is
	// read here too, on any night, from the two times side by side.
	const calls = Array.isArray(record.calls) ? record.calls : [];
	const called =
		calls.length > 0
			? [
					`scheduled ${calls[0].scheduledTime}, ${calls.length} call(s) began ${calls
						.map(
							(call) => `${call.at}${call.stoodAside ? " (stood aside)" : ""}`,
						)
						.join(", ")}`,
				]
			: [];
	// A call that never wrote its end: the passes as its nights wrote them.
	const ended = record.finishedAt ? undefined : nightsEnded(record);
	const told = ended?.open === 0 ? ended : undefined;
	return [
		`started ${record.startedAt}`,
		...called,
		record.finishedAt ? `finished ${record.finishedAt}` : "no end recorded",
		...(ended
			? [
					`${ended.considered - ended.open} of ${ended.considered} night(s) wrote their end`,
				]
			: []),
		phase("backups", told?.backups ?? record.backups),
		phase("spam purge", told?.spamPurge ?? record.spamPurge),
		deletions
			? `unfinished deletions ${deletions.finished} finished, ${deletions.left} left`
			: "unfinished deletions not recorded",
	].join("; ");
}
