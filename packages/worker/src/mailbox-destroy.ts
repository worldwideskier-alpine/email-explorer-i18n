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
	const objects = await deleteKeys(env, keys);

	try {
		await stub.destroyMailbox();
	} catch {
		// Already gone, or never existed. The bucket is what remains either
		// way, and it has just been cleared.
	}

	const authStub = env.MAILBOX.get(env.MAILBOX.idFromName("AUTH"));
	await authStub.revokeAllMailboxAccess(mailboxId);

	return { mailboxId, emails: emailIds.length, objects };
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
