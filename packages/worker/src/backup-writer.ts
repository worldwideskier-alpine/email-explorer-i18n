/**
 * Writes one mailbox to R2 as an mbox archive, then rotates the old ones out.
 *
 * The archive is uploaded in parts rather than assembled first. R2 refuses a
 * stream whose length it does not know ("Provided readable stream must have a
 * known length"), and buffering the whole mailbox would put a ceiling on how
 * large a mailbox can be backed up at all -- exactly the mailbox for which a
 * backup matters most. Multipart has no such ceiling: parts go out as they
 * fill, and only one part is held at a time.
 */

import { backupKey, backupKeyPrefix, keysToRotate } from "./auto-backup";
import { renderMboxEntry } from "./mbox";
import type { Env } from "./types";

/**
 * R2 requires every part except the last to be at least 5 MiB *and* for all
 * of them to be exactly the same length. The second half is the one that
 * caught us out: parts were flushed whenever the buffer happened to cross the
 * threshold, so each one came out a different size -- 5 MiB plus whatever the
 * message that tipped it over happened to weigh. Two such parts and
 * `complete()` fails with
 *
 *   completeMultipartUpload: All non-trailing parts must have the same length.
 *
 * which meant no mailbox large enough to need three parts could be backed up
 * at all, while smaller ones worked and looked like proof the feature was
 * fine.
 */
export const PART_SIZE = 5 * 1024 * 1024;

/** R2 delete accepts up to 1000 keys per call. */
const DELETE_BATCH = 1000;

export interface BackupResult {
	key: string;
	messages: number;
	bytes: number;
	removed: number;
}

/**
 * Buffers encoded chunks until a part is full, then hands over exactly one
 * part's worth. Keeping the pieces and their total separately avoids copying
 * the whole buffer on every append, which for a large mailbox would dominate
 * the run.
 *
 * Exported for its own tests: this is where the part sizes are decided, and
 * getting them wrong is not visible until a mailbox grows past two parts.
 */
export class PartBuffer {
	#pieces: Uint8Array[] = [];
	#size = 0;

	add(bytes: Uint8Array): void {
		if (bytes.byteLength === 0) return;
		this.#pieces.push(bytes);
		this.#size += bytes.byteLength;
	}

	get size(): number {
		return this.#size;
	}

	/**
	 * Removes and returns exactly `count` bytes, or everything held if that is
	 * less. A message that straddles the boundary is split: its tail stays for
	 * the next part rather than making this one longer than the last.
	 */
	take(count: number): Uint8Array {
		const wanted = Math.min(Math.max(count, 0), this.#size);
		const out = new Uint8Array(wanted);
		let at = 0;
		while (at < wanted) {
			const piece = this.#pieces[0] as Uint8Array;
			const room = wanted - at;
			if (piece.byteLength <= room) {
				out.set(piece, at);
				at += piece.byteLength;
				this.#pieces.shift();
			} else {
				out.set(piece.subarray(0, room), at);
				this.#pieces[0] = piece.subarray(room);
				at = wanted;
			}
		}
		this.#size -= wanted;
		return out;
	}
}

/**
 * Writes the mailbox out and returns what happened. Throws if the archive
 * could not be written; the caller records that on the mailbox so a failed
 * backup is visible rather than silent.
 */
export async function writeMailboxBackup(
	env: Env,
	mailboxId: string,
	now: Date,
	keep: number,
): Promise<BackupResult> {
	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
	const ids = await stub.listEmailIdsByDate();

	const folderNames = new Map<string, string>();
	for (const folder of await stub.getFolders()) {
		folderNames.set(String(folder.id), String(folder.name));
	}

	const key = backupKey(mailboxId, now);
	const upload = await env.BUCKET.createMultipartUpload(key);
	const encoder = new TextEncoder();
	const buffer = new PartBuffer();
	const parts: R2UploadedPart[] = [];
	let messages = 0;
	let bytes = 0;

	try {
		for (const id of ids) {
			const email = await stub.getEmail(id);
			if (!email) continue;
			const folderId = String(
				(email as { folder_id?: string }).folder_id ?? "inbox",
			);
			const entry = await renderMboxEntry(
				env,
				email as never,
				folderNames.get(folderId) ?? folderId,
			);
			const encoded = encoder.encode(entry);
			buffer.add(encoded);
			bytes += encoded.byteLength;
			messages += 1;

			// A loop, not an `if`: one message with a large attachment can fill
			// several parts at once.
			while (buffer.size >= PART_SIZE) {
				parts.push(
					await upload.uploadPart(parts.length + 1, buffer.take(PART_SIZE)),
				);
			}
		}

		// The last part carries whatever is left and may be under the minimum.
		// An empty mailbox still gets an object, so "the backup ran and the
		// mailbox was empty" is distinguishable from "the backup never ran".
		if (buffer.size > 0 || parts.length === 0) {
			parts.push(
				await upload.uploadPart(parts.length + 1, buffer.take(buffer.size)),
			);
		}

		await upload.complete(parts);
	} catch (e) {
		// Without this the bucket keeps paying for the parts of a run that
		// never finished, and nothing would ever clean them up.
		await upload.abort().catch(() => {});
		throw e;
	}

	return { key, messages, bytes, removed: await rotate(env, mailboxId, keep) };
}

/**
 * Removes the oldest archives beyond the retention count. This is the only
 * code in the application that deletes a backup; there is no endpoint for it
 * on purpose.
 */
export async function rotate(
	env: Env,
	mailboxId: string,
	keep: number,
): Promise<number> {
	const keys: string[] = [];
	let cursor: string | undefined;
	do {
		const listed = await env.BUCKET.list({
			prefix: backupKeyPrefix(mailboxId),
			cursor,
		});
		for (const obj of listed.objects) keys.push(obj.key);
		cursor = listed.truncated ? listed.cursor : undefined;
	} while (cursor);

	const doomed = keysToRotate(keys, keep);
	for (let i = 0; i < doomed.length; i += DELETE_BATCH) {
		await env.BUCKET.delete(doomed.slice(i, i + DELETE_BATCH));
	}
	return doomed.length;
}

export interface StoredBackup {
	name: string;
	at: string;
	size: number;
}

export async function listBackups(
	env: Env,
	mailboxId: string,
): Promise<StoredBackup[]> {
	const prefix = backupKeyPrefix(mailboxId);
	const out: StoredBackup[] = [];
	let cursor: string | undefined;
	do {
		const listed = await env.BUCKET.list({ prefix, cursor });
		for (const obj of listed.objects) {
			out.push({
				name: obj.key.slice(prefix.length),
				at: obj.uploaded.toISOString(),
				size: obj.size,
			});
		}
		cursor = listed.truncated ? listed.cursor : undefined;
	} while (cursor);

	// Newest first: that is the one a person reaching for a backup wants.
	return out.sort((a, b) => (a.name < b.name ? 1 : -1));
}
