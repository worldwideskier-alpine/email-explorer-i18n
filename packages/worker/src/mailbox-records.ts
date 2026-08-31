/**
 * Reading and updating the stored settings for every mailbox.
 *
 * The scheduled pass needs this twice over -- once to decide which mailboxes
 * are due for a backup, once to decide which are due for a spam purge -- and
 * both then write their outcome back. Keeping it in one place means the two
 * cannot drift into disagreeing about where a mailbox's settings live or how
 * an outcome is recorded on it.
 */

import type { AutoBackupSettings } from "./auto-backup";
import type { SpamRetentionSettings } from "./spam-retention";
import type { Env } from "./types";

export interface MailboxRecord {
	id: string;
	settings: Record<string, unknown> & {
		autoBackup?: AutoBackupSettings;
		spamRetention?: SpamRetentionSettings;
	};
}

export async function listMailboxes(env: Env): Promise<MailboxRecord[]> {
	const out: MailboxRecord[] = [];
	let cursor: string | undefined;
	do {
		const listed = await env.BUCKET.list({ prefix: "mailboxes/", cursor });
		for (const obj of listed.objects) {
			const id = obj.key.slice("mailboxes/".length).replace(/\.json$/, "");
			if (!id) continue;
			const stored = await env.BUCKET.get(obj.key);
			out.push({
				id,
				settings: stored
					? ((await stored.json()) as MailboxRecord["settings"])
					: {},
			});
		}
		cursor = listed.truncated ? listed.cursor : undefined;
	} while (cursor);
	return out;
}

/**
 * Applies a change to one mailbox's stored settings.
 *
 * Reads again rather than reusing the copy from the top of the run: writing a
 * whole archive or deleting a folderful of mail takes a while, and the
 * settings may have been saved from the browser in between. The mutation
 * therefore has to touch only the fields the run owns, and leave the object
 * it is handed otherwise intact.
 */
export async function updateMailboxSettings(
	env: Env,
	mailboxId: string,
	mutate: (settings: MailboxRecord["settings"]) => void,
): Promise<void> {
	const key = `mailboxes/${mailboxId}.json`;
	const stored = await env.BUCKET.get(key);
	if (!stored) return;

	const settings = (await stored.json()) as MailboxRecord["settings"];
	mutate(settings);
	await env.BUCKET.put(key, JSON.stringify(settings));
}
