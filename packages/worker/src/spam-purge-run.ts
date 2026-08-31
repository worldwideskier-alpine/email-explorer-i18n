/**
 * The scheduled pass that empties the back of each mailbox's spam folder.
 *
 * Runs after the backup pass, not before: see runScheduledMaintenance. The
 * ordering is what makes a permanent deletion here safe to offer at all.
 *
 * Every run records what happened on the mailbox, success or failure, for the
 * same reason the backup does. A deletion that stopped running is invisible
 * until someone opens the folder and finds a year of spam in it; a deletion
 * that is failing every night is worse, and neither shows up anywhere else.
 */

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
 * Removes one mailbox's expired spam and returns how many messages went.
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
): Promise<number> {
	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
	const expired = expiredSpamIds(
		await stub.listSpamEmailDates(),
		retentionCutoff(days, now.getTime()),
	);

	const keys: string[] = [];
	for (const id of expired) {
		const attachments = await stub.deleteEmail(id);
		for (const attachment of attachments) {
			const att = attachment as { id: string; filename: string };
			keys.push(`attachments/${id}/${att.id}/${att.filename}`);
		}
		keys.push(`raw/${id}.eml`);
	}
	await deleteKeys(env, keys);

	return expired.length;
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
			const deleted = await purgeMailboxSpam(
				env,
				mailbox.id,
				now,
				retention.days,
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
