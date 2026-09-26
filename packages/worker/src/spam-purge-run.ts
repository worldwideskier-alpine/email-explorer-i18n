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
	let newest: string | null = null;
	let cursor: string | undefined;
	do {
		const page = await env.BUCKET.list({
			prefix: backupKeyPrefix(mailboxId),
			cursor,
		});
		for (const object of page.objects) {
			if (newest === null || object.key > newest) newest = object.key;
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	if (newest === null) return null;

	const stamp =
		/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.mbox$/.exec(newest);
	if (!stamp) return null;
	const [, day, h, m, sec, ms] = stamp;
	const at = Date.parse(`${day}T${h}:${m}:${sec}.${ms}Z`);
	return Number.isFinite(at) ? at : null;
}

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
): Promise<number> {
	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
	const listed = await stub.listSpamEmailDates();
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
	const expired = expiredSpamIds(
		archived,
		retentionCutoff(days, now.getTime()),
	);

	const keys: string[] = [];
	let deleted = 0;
	for (const id of expired) {
		const attachments = await stub.deleteEmail(id, "spam");
		if (attachments === null) continue;
		deleted += 1;
		for (const attachment of attachments) {
			const att = attachment as { id: string; filename: string };
			keys.push(`attachments/${id}/${att.id}/${att.filename}`);
		}
		keys.push(`raw/${id}.eml`);
	}
	await deleteKeys(env, keys);

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
): Promise<SpamPurgeSummary> {
	const mailboxes = await listMailboxes(env);
	const summary: SpamPurgeSummary = {
		considered: mailboxes.length,
		ran: 0,
		deleted: 0,
		failed: 0,
	};

	for (const mailbox of mailboxes) {
		const retention = mailbox.settings.spamRetention;
		if (!retention?.enabled) continue;

		try {
			// No archive at all means nothing is covered yet, so nothing goes.
			const archivedBefore = mailbox.settings.autoBackup?.enabled
				? ((await newestArchiveAt(env, mailbox.id)) ?? Number.NEGATIVE_INFINITY)
				: undefined;
			const deleted = await purgeMailboxSpam(
				env,
				mailbox.id,
				now,
				retention.days,
				archivedBefore,
			);
			summary.ran += 1;
			summary.deleted += deleted;
			await recordResult(env, mailbox.id, {
				at: now.toISOString(),
				ok: true,
				deleted,
			});
		} catch (e) {
			// One mailbox failing must not stop the others, for the same reason
			// it must not in the backup pass: they are separate mailboxes and a
			// large one running out of budget should not take a small one down.
			summary.failed += 1;
			await recordResult(env, mailbox.id, {
				at: now.toISOString(),
				ok: false,
				error: String(e instanceof Error ? e.message : e).slice(0, 300),
			}).catch(() => {});
		}
	}

	return summary;
}
