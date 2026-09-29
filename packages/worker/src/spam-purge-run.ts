/**
 * The scheduled pass that empties the back of each mailbox's spam folder.
 *
 * Runs after the backup pass, not before: see runScheduledMaintenance. The
 * ordering is what makes a permanent deletion here safe to offer at all --
 * but only the ordering's intent. Tonight's archive may not exist: the backup
 * may have failed, been cut off (as it was, two nights running), or not been
 * due, since a weekly or monthly backup is not taken every night. So for a
 * mailbox whose backups are on, what is deleted is limited to what an archive
 * in the bucket actually holds -- see newestArchiveAt. A mailbox with backups
 * off is told on its settings screen that what this deletes is kept nowhere.
 *
 * Every run records what happened on the mailbox, success or failure, for the
 * same reason the backup does. A deletion that stopped running is invisible
 * until someone opens the folder and finds a year of spam in it; a deletion
 * that is failing every night is worse, and neither shows up anywhere else.
 */

import { backupKeyPrefix } from "./auto-backup";
import type { TimeLimits } from "./deadline";
import { limitedBy, pastDeadline, recordingWithin } from "./deadline";
import { listMailboxes, updateMailboxSettings } from "./mailbox-records";
import type { SpamRetentionSettings } from "./spam-retention";
import { expiredSpamIds, retentionCutoff } from "./spam-retention";
import type { Env } from "./types";

/** R2 delete accepts up to 1000 keys per call. */
const DELETE_BATCH = 1000;

async function recordResult(
	env: Env,
	mailboxId: string,
	result: NonNullable<SpamRetentionSettings["lastResult"]>,
): Promise<void> {
	await updateMailboxSettings(env, mailboxId, (settings) => {
		settings.spamRetention = {
			...settings.spamRetention,
			lastRunAt: result.at,
			lastResult: result,
		};
	});
}

async function deleteKeys(env: Env, keys: string[]): Promise<void> {
	for (let i = 0; i < keys.length; i += DELETE_BATCH) {
		await env.BUCKET.delete(keys.slice(i, i + DELETE_BATCH));
	}
}

/**
 * When the newest archive of this mailbox was taken, or null if it has none.
 *
 * Read from the bucket rather than from the mailbox's record of its last run:
 * the record holds only the latest run, so one failure hides every earlier
 * success, and it is a claim about an archive where the key is the archive.
 * An archive's key is stamped with the moment its run began and it becomes an
 * object only once complete, so every message that arrived before that moment
 * and was still in the mailbox is inside it.
 */
export async function newestArchiveAt(
	env: Env,
	mailboxId: string,
): Promise<number | null> {
	// The newest by the moment each key names, not the greatest key: any
	// object under the prefix whose name is not a stamp -- one put there by
	// hand, or by a later version -- sorted above the real ones, read as no
	// archive at all, and the purge then deleted nothing, every night, with
	// nothing to say why.
	let newest: number | null = null;
	let cursor: string | undefined;
	do {
		const page = await env.BUCKET.list({
			prefix: backupKeyPrefix(mailboxId),
			cursor,
		});
		for (const object of page.objects) {
			const at = archiveStampOf(object.key);
			if (at !== null && (newest === null || at > newest)) newest = at;
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	return newest;
}

/** When an archive's run began, from its key; null for a key that is not one. */
function archiveStampOf(key: string): number | null {
	const stamp =
		/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.mbox$/.exec(key);
	if (!stamp) return null;
	const [, day, h, m, sec, ms] = stamp;
	const at = Date.parse(`${day}T${h}:${m}:${sec}.${ms}Z`);
	return Number.isFinite(at) ? at : null;
}

/** How many messages one call to the mailbox deletes. */
const PURGE_RUN = 99;

/**
 * Removes one mailbox's expired spam and returns how many messages went.
 *
 * `archivedBefore`, when given, is a second cutoff: nothing that arrived at
 * or after it goes, because no archive holds it yet. It waits for the next.
 * Arrival is `received_at`, not the message's date -- see migration
 * 8_received_at.
 *
 * The row is deleted first and the objects after. The other order would leave
 * a message in the folder whose body and attachments had already been removed
 * from the bucket -- an entry that opens to nothing, which is worse than
 * either a clean deletion or no deletion at all. This way a failure partway
 * leaves orphaned objects in the bucket instead, which cost storage and
 * nothing else.
 */
export async function purgeMailboxSpam(
	env: Env,
	mailboxId: string,
	now: Date,
	days: unknown,
	archivedBefore?: number,
	/**
	 * Each call is held to the per-call limit and the deadline, and a pass
	 * past its deadline stops between runs. Given only the deadline as a
	 * whole, one call that did not answer held the purge until then -- every
	 * mailbox after it went without, in the same order every night -- and
	 * the purge left behind went on deleting after the pass had moved on.
	 */
	limits: TimeLimits = {},
): Promise<number> {
	const call = limitedBy(limits);
	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
	const listed = await call(stub.listSpamEmailDates(), "listing the spam");
	// Old enough by the date the message carries, and -- when backups are on
	// -- here since before the newest archive by when it actually arrived.
	// The two are different clocks for a restored message, and only arrival
	// says whether an archive holds it.
	const archived =
		archivedBefore === undefined
			? listed
			: listed.filter((email) => {
					const at = Date.parse(email.receivedAt ?? "");
					return Number.isFinite(at) && at < archivedBefore;
				});
	// Expiry runs from when the message became spam. Its own date is only
	// the fallback for a row that predates the column, which is what expiry
	// used to count from -- so an old message filed as spam today was gone
	// by the next night.
	const expired = expiredSpamIds(
		archived.map((email) => ({
			id: email.id,
			date: email.spamSince ?? email.date,
		})),
		retentionCutoff(days, now.getTime()),
	);

	// A run at a time, each run's objects deleted before the next: a pass cut
	// off partway leaves at most one run's objects behind rather than all of
	// them. Only what is still in spam goes -- a message rescued while this
	// runs stays where it was put.
	let deleted = 0;
	for (let from = 0; from < expired.length; from += PURGE_RUN) {
		// What is left waits for tomorrow, when it is due again.
		if (pastDeadline(limits)) break;
		const gone = await call(
			stub.deleteEmailsIn(expired.slice(from, from + PURGE_RUN), "spam"),
			"deleting a run of spam",
		);
		const keys: string[] = [];
		for (const { id, attachments } of gone) {
			for (const att of attachments) {
				keys.push(`attachments/${id}/${att.id}/${att.filename}`);
			}
			keys.push(`raw/${id}.eml`);
		}
		// The rows are gone already: counted whether or not their objects go
		// too, which leaves them for the sweep rather than a wrong total.
		deleted += gone.length;
		await call(deleteKeys(env, keys), "deleting the spam's objects");
	}

	return deleted;
}

export interface SpamPurgeSummary {
	considered: number;
	ran: number;
	deleted: number;
	failed: number;
}

export async function runScheduledSpamPurge(
	env: Env,
	now: Date = new Date(),
	/**
	 * When the purge must be done by. Each mailbox's purge is bounded by what
	 * is left of that rather than by the one-minute call limit, because
	 * deleting a long backlog of spam can honestly take longer than a minute;
	 * a mailbox not started by then is left for tomorrow, when it is due
	 * again. See deadline.ts.
	 */
	limits: TimeLimits = {},
): Promise<SpamPurgeSummary> {
	// As in the backup pass: the deadline decides which mailboxes are
	// started, and the calls around that are held to the per-call limit.
	const call = recordingWithin(limits);
	const mailboxes = await call(listMailboxes(env), "listing mailboxes");
	const summary: SpamPurgeSummary = {
		considered: mailboxes.length,
		ran: 0,
		deleted: 0,
		failed: 0,
	};

	// Longest since its last run first, as the backups go: in the order the
	// bucket lists them, a mailbox that used the whole pass every night kept
	// every mailbox after it from ever being purged.
	const lastRun = (mailbox: (typeof mailboxes)[number]) =>
		Date.parse(mailbox.settings.spamRetention?.lastRunAt ?? "") || 0;
	const inTurn = [...mailboxes].sort((a, b) => lastRun(a) - lastRun(b));

	for (const mailbox of inTurn) {
		const retention = mailbox.settings.spamRetention;
		if (!retention?.enabled) continue;
		// Not started is not failed: nothing was deleted, which is the safe
		// direction, and the mailbox is simply due again tomorrow.
		if (pastDeadline(limits)) continue;

		try {
			// No archive at all means nothing is covered yet, so nothing goes.
			const archivedBefore = mailbox.settings.autoBackup?.enabled
				? ((await call(
						newestArchiveAt(env, mailbox.id),
						"finding the newest archive",
					)) ?? Number.NEGATIVE_INFINITY)
				: undefined;
			const deleted = await purgeMailboxSpam(
				env,
				mailbox.id,
				now,
				retention.days,
				archivedBefore,
				limits,
			);
			summary.ran += 1;
			summary.deleted += deleted;
			await call(
				recordResult(env, mailbox.id, {
					at: now.toISOString(),
					ok: true,
					deleted,
				}),
				"recording the result",
			).catch(() => {});
		} catch (e) {
			// One mailbox failing must not stop the others, for the same reason
			// it must not in the backup pass: they are separate mailboxes and a
			// large one running out of budget should not take a small one down.
			summary.failed += 1;
			await call(
				recordResult(env, mailbox.id, {
					at: now.toISOString(),
					ok: false,
					error: String(e instanceof Error ? e.message : e).slice(0, 300),
				}),
				"recording the result",
			).catch(() => {});
		}
	}

	return summary;
}
