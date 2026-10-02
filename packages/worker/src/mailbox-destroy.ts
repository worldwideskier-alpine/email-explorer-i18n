/**
 * Removing a mailbox and everything that is a copy of it.
 *
 * "Delete" has to mean it. Root deleting somebody is how a deployment stops
 * serving a customer who has stopped paying for it, and a deletion that
 * leaves the mail in the bucket has not stopped anything: the messages are
 * still there, still costing storage, still readable by whoever holds the
 * Cloudflare account, and no screen anywhere says so. Half a deletion is the
 * worst of both -- it looks finished and is not.
 *
 * Five places hold a piece of a mailbox, and all five have to go:
 *
 *  - the Durable Object (messages, folders, drafts, its settings)
 *  - `raw/{emailId}.eml`, the message as it arrived
 *  - `attachments/{emailId}/{attachmentId}/{filename}`
 *  - `mailboxes/{id}.json`, the settings object
 *  - `backups/{id}/*.mbox`, every archive ever taken
 *  - `mailboxes-deleted/{id}.json`, the settings kept by a delete without
 *    purge so that recreating the address brings them back
 *  - `backup-carry/{id}.*`, a backup paused between two alarms: part of the
 *    mail, with its upload still open
 *
 * The archives are the one most easily forgotten and the one that matters
 * most: they are complete copies of the mail, written nightly, and a deletion
 * that skips them deletes nothing in any sense a customer would recognise.
 *
 * The deletion lock is not consulted. It exists so that an administrator
 * cannot destroy their own mailbox by mis-clicking; it is not a defence
 * against the person running the deployment, and treating it as one would
 * mean an account that cannot be deleted because of a checkbox its own owner
 * ticked.
 */

import { abandonPausedBackup, pausedBackupKeys } from "./backup-writer";
import type { TimeLimits } from "./deadline";
import { pastDeadline, within } from "./deadline";
import { rewriteJson } from "./r2-json";
import type { Env } from "./types";

/** R2 accepts up to 1000 keys per delete; stay well inside it. */
const DELETE_BATCH = 200;

async function deleteKeys(env: Env, keys: string[]): Promise<number> {
	for (let i = 0; i < keys.length; i += DELETE_BATCH) {
		await env.BUCKET.delete(keys.slice(i, i + DELETE_BATCH));
	}
	return keys.length;
}

async function listKeys(env: Env, prefix: string): Promise<string[]> {
	const keys: string[] = [];
	let cursor: string | undefined;
	do {
		const listed = await env.BUCKET.list({ prefix, cursor });
		for (const object of listed.objects) keys.push(object.key);
		cursor = listed.truncated ? listed.cursor : undefined;
	} while (cursor);
	return keys;
}

/** How many times the object's own wipe is asked for before giving up. */
const WIPE_ATTEMPTS = 3;

async function wipe(stub: { destroyMailbox(): Promise<void> }): Promise<void> {
	let last: unknown;
	for (let attempt = 1; attempt <= WIPE_ATTEMPTS; attempt++) {
		try {
			await stub.destroyMailbox();
			return;
		} catch (e) {
			last = e;
		}
	}
	throw new Error(
		`the mailbox's messages could not be removed: ${String(
			last instanceof Error ? last.message : last,
		)}`,
	);
}

export interface DestroyedMailbox {
	mailboxId: string;
	emails: number;
	objects: number;
}

export async function destroyMailboxCompletely(
	env: Env,
	mailboxId: string,
): Promise<DestroyedMailbox> {
	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));

	// The ids first: destroying the Durable Object takes the only record of
	// which R2 objects belonged to this mailbox with it.
	// Not caught. Asking a stub wakes the object rather than failing, so a
	// failure here is a real one -- and carrying on to destroyMailbox would
	// wipe the only record of which objects were this mailbox's, leaving its
	// mail in the bucket with nothing naming it.
	//
	// Closed before they are read: mail delivered after the read would
	// otherwise land in the object being wiped, or leave its bucket objects
	// behind with nothing naming them. See 12_mailbox_closed.
	await stub.closeMailbox();
	const emailIds: string[] = await stub.listAllEmailIds();

	const wanted = new Set(emailIds);
	// The settings first: while they exist the address accepts mail, and mail
	// arriving during the rest of this went into an object being wiped.
	const keys: string[] = [
		`mailboxes/${mailboxId}.json`,
		deletedMailboxKey(mailboxId),
		...emailIds.map((id) => `raw/${id}.eml`),
	];

	// Attachment keys carry the email id, so one scan of the prefix finds
	// them all; listing per message would burn a subrequest each.
	for (const key of await listKeys(env, "attachments/")) {
		const emailId = key.slice("attachments/".length).split("/")[0];
		if (emailId && wanted.has(emailId)) keys.push(key);
	}

	keys.push(
		...(await listKeys(env, `backups/${encodeURIComponent(mailboxId)}/`)),
	);
	// Its upload aborted first, which only the carry can name; the carry's
	// objects go with the rest either way.
	await abandonPausedBackup(env, mailboxId).catch(() => {});
	for (const key of pausedBackupKeys(mailboxId)) {
		if (await env.BUCKET.head(key)) keys.push(key);
	}
	const objects = await deleteKeys(env, keys);

	// The messages themselves. A failure here used to be swallowed as
	// "already gone, or never existed" -- which asking a stub never is, see
	// above -- and the deletion answered "deleted" with every message, body
	// and sender still in the object, the address unusable for good (it
	// still holds mail) and nothing on any screen. So a failure is tried
	// again, and then thrown for the caller to report.
	await wipe(stub);

	const authStub = env.MAILBOX.get(env.MAILBOX.idFromName("AUTH"));
	await authStub.revokeAllMailboxAccess(mailboxId);

	return { mailboxId, emails: emailIds.length, objects };
}

/**
 * Mailboxes whose deletion did not finish, for the nightly run to finish.
 *
 * When a mailbox's own object could not be wiped, its person was already
 * gone -- the account rows go first, so that nobody can reach the mail while
 * the rest is removed -- and asking again answered 404. The messages stayed,
 * and the address could be given to nobody. So the mailbox is written down
 * here and every night tries it again until it goes.
 */
export const UNFINISHED_DELETIONS_KEY = "maintenance/unfinished-deletions.json";

export async function rememberUnfinishedDeletion(
	env: Env,
	...mailboxIds: string[]
): Promise<void> {
	await rewriteJson<string[]>(
		env.BUCKET,
		UNFINISHED_DELETIONS_KEY,
		(stored) => {
			const ids = Array.isArray(stored) ? stored : [];
			const added = mailboxIds.filter((id) => !ids.includes(id));
			return added.length === 0 ? undefined : [...ids, ...added];
		},
	);
}

export interface UnfinishedDeletionsSummary {
	finished: number;
	left: number;
}

/**
 * Tries each unfinished deletion again, within the pass's deadline. One that
 * still fails stays on the list for the next night; one finished comes off.
 */
export async function finishUnfinishedDeletions(
	env: Env,
	limits: TimeLimits = {},
): Promise<UnfinishedDeletionsSummary> {
	const stored = await env.BUCKET.get(UNFINISHED_DELETIONS_KEY);
	const ids = stored ? await stored.json<unknown>().catch(() => []) : [];
	const pending = Array.isArray(ids)
		? ids.filter((id): id is string => typeof id === "string")
		: [];
	let finished = 0;
	for (const mailboxId of pending) {
		if (pastDeadline(limits)) break;
		// Created again since, by whoever may: a deletion takes the settings
		// object first, and only PostMailbox writes one. What is there now
		// is somebody's new mailbox -- this run used to destroy it, their
		// mail and archives with it -- and creating it required the old one
		// to hold no mail, so there is nothing of the deletion left to do.
		if (await env.BUCKET.head(`mailboxes/${mailboxId}.json`)) {
			await forgetUnfinishedDeletion(env, mailboxId);
			finished += 1;
			continue;
		}
		try {
			// The deadline alone, not the per-call limit: this is one whole
			// deletion, whose attachment scan alone can take more than a minute.
			await within(
				destroyMailboxCompletely(env, mailboxId),
				(limits.deadline ?? Number.POSITIVE_INFINITY) - Date.now(),
				`finishing the deletion of ${mailboxId}`,
			);
		} catch (e) {
			console.error(`Deleting ${mailboxId} did not finish again:`, e);
			continue;
		}
		finished += 1;
		await forgetUnfinishedDeletion(env, mailboxId);
	}
	return { finished, left: pending.length - finished };
}

/** Takes one mailbox off the list of unfinished deletions. */
export async function forgetUnfinishedDeletion(
	env: Env,
	mailboxId: string,
): Promise<void> {
	await rewriteJson<string[]>(env.BUCKET, UNFINISHED_DELETIONS_KEY, (now) =>
		Array.isArray(now) && now.includes(mailboxId)
			? now.filter((id) => id !== mailboxId)
			: undefined,
	);
}

/**
 * Where a delete without purge keeps the settings, for the person who holds
 * the mailbox to have back when they recreate it. Outside `mailboxes/`, so
 * nothing that lists the live mailboxes sees it.
 */
export function deletedMailboxKey(mailboxId: string): string {
	return `mailboxes-deleted/${mailboxId}.json`;
}

/** Whether an address still has mail or archives stored under it. */
export async function holdsMailOrArchives(
	env: Env,
	mailboxId: string,
): Promise<boolean> {
	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
	if ((await stub.listAllEmailIds()).length > 0) return true;
	const archives = await env.BUCKET.list({
		prefix: `backups/${encodeURIComponent(mailboxId)}/`,
		limit: 1,
	});
	return archives.objects.length > 0;
}
