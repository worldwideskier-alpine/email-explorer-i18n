/**
 * Writes one mailbox to R2 as an mbox archive, then rotates the old ones out.
 *
 * The archive is uploaded in parts rather than assembled first. R2 refuses a
 * stream whose length it does not know ("Provided readable stream must have a
 * known length"), and buffering the whole mailbox would put a ceiling on how
 * large a mailbox can be backed up at all -- exactly the mailbox for which a
 * backup matters most. Multipart has no such ceiling: parts go out as they
 * fill, and only one part is held at a time.
 *
 * The renders are concurrent, so what is held at once is that part plus the
 * messages currently being built -- bounded by their own size and not only by
 * their number; see renderBatches. Going over is not an exception this code
 * can catch: the isolate is killed, which is the fault the concurrency was
 * added to fix, arriving from the other side and on the largest mailboxes.
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

/**
 * How many messages to read from the Durable Object at once.
 *
 * One at a time was over 1500 round trips for the live mailbox, inside an
 * invocation that also does one R2 read per message. A hundred at a time makes
 * that sixteen. Kept well under SQLite's limit on bound variables, since the
 * read binds one per id.
 */
const READ_BATCH = 100;

/**
 * How often to say how far this mailbox has got.
 *
 * Every message would be a write to R2 per message, which is the cost this
 * change exists to remove. Every few hundred is enough to answer the question
 * a killed run leaves behind -- which mailbox, and roughly where in it.
 */
const PROGRESS_EVERY = 250;

/**
 * How many messages to render at once inside a page.
 *
 * The reads were batched and the *renders* were not: a hundred rows came back
 * in one round trip and were then turned into mbox entries one at a time, each
 * waiting on its own `BUCKET.get` before the next one started. A page of a
 * hundred was a hundred round trips end to end, and the batching bought only
 * the sixteen it replaced.
 *
 * Measured on the live deployment: the run reached 300 messages into the
 * second mailbox 12m30s in and was killed there, on a night when the whole run
 * -- both mailboxes and the purge -- had finished in 8m45s not long before.
 * Half a second per message is what a serial round trip costs, and there is
 * nothing about the work that requires them to be serial.
 *
 * Bounded rather than the whole page, because each one holds a rendered
 * message and its attachments in memory until it is appended. Twelve is chosen
 * to be a large multiple of the serial cost while staying a small number of
 * messages; how many the runtime will really run at once is its business, and
 * a lower ceiling there costs speed rather than correctness.
 */
const RENDER_CONCURRENCY = 12;

/**
 * And how many bytes of message may be in flight at once.
 *
 * A count alone is not a memory bound. Mail here is mostly small and twelve of
 * it is nothing, but a mailbox holding twelve twenty-megabyte attachments in a
 * row would build them all at the same time -- and each render holds the
 * source, the escaped copy and the joined copy at once, so the isolate sees
 * several times that again. Over the limit there is no exception to catch:
 * the invocation is killed with nothing recorded, which is the exact fault
 * this file has spent three commits chasing.
 *
 * Twenty-four megabytes of *estimated source*, which is well short of what is
 * held. Counting the copies the render actually makes -- the fetched bytes,
 * the base64 lines, the joined parts, the joined message, the encoded bytes,
 * the escaped copy and the concatenation -- it is nearer six times the
 * attachment bytes, not the four an earlier draft of this comment claimed.
 * Add the part buffer and the batch's other renders on top.
 *
 * So the headroom against a 128 MiB isolate is real but narrower than the
 * ratio suggests, and the number below is a budget rather than a measurement.
 * The case it cannot make safe on its own is a single message near the 20 MiB
 * a message may carry: renderBatches gives it a batch of its own, and that is
 * all a batching rule can do about one message. What made that affordable is
 * base64Lines no longer building the whole encoding three times over; see
 * mbox.ts.
 *
 * Eight was the first choice and was too tight to do its job. One message with
 * three and a half megabytes of attachments already exceeded the whole budget,
 * so a mailbox of photographs went back to rendering one message at a time --
 * the serial behaviour, and the 12m30s kill, that the concurrency was added to
 * remove. A bound that only lets ordinary mail through is a bound on the wrong
 * mailbox.
 *
 * No minimum batch size, though it would keep the concurrency for the largest
 * mail too: two twenty-megabyte messages forced together are what the byte
 * bound exists to prevent, and a floor that overrides it is the crash written
 * a second way.
 */
const RENDER_BYTES = 24 * 1024 * 1024;

/**
 * What an attachment weighs in memory while its message is being built.
 *
 * Two different paths and the larger of them is the bound. A received message
 * is held as the raw .eml it arrived as, in which the attachment is already
 * base64 -- four bytes for every three. One this fork composed has no raw
 * form, so `synthesizeMessage` fetches the attachment *and* base64s it, and
 * holds both: the bytes plus four thirds of them again.
 *
 * Seven thirds is the larger of those, so the estimate is not wrong in the
 * direction that matters. It sizes the *source*, not the peak: the copies each
 * render makes on top of it are accounted for in the budget below, not here.
 */
const ATTACHMENT_GROWTH = 7 / 3;

/**
 * What a message costs to render, before rendering it.
 *
 * Estimated from what the row already carries -- `attachments.size` and the
 * body text -- because asking R2 how large the raw message is would be the
 * round trip per message that batching exists to remove. Attachments are the
 * only term that varies by orders of magnitude, so an estimate built on them
 * is wrong about small messages by a few kilobytes and right about the ones
 * that matter.
 */
export function renderCost(email: {
	body?: unknown;
	attachments?: { size?: unknown }[];
}): number {
	const attached = (email.attachments ?? []).reduce((sum, one) => {
		const size = Number(one?.size);
		return sum + (Number.isFinite(size) && size > 0 ? size : 0);
	}, 0);
	const body = typeof email.body === "string" ? email.body.length : 0;
	// Headers, the mbox wrapper, and a body that is not there on a received
	// message because the raw one is used instead.
	return 64 * 1024 + body + Math.ceil(attached * ATTACHMENT_GROWTH);
}

/**
 * The groups of a page that may be rendered at the same time.
 *
 * Split on either bound, and never empty: a message larger than the whole
 * budget is rendered on its own rather than not at all, which is what the
 * serial loop did with every message and remains the honest floor.
 */
export function renderBatches<
	T extends { body?: unknown; attachments?: { size?: unknown }[] },
>(page: T[]): T[][] {
	const batches: T[][] = [];
	let batch: T[] = [];
	let cost = 0;

	for (const email of page) {
		const next = renderCost(email);
		const full =
			batch.length >= RENDER_CONCURRENCY || cost + next > RENDER_BYTES;
		if (batch.length > 0 && full) {
			batches.push(batch);
			batch = [];
			cost = 0;
		}
		batch.push(email);
		cost += next;
	}

	if (batch.length > 0) batches.push(batch);
	return batches;
}

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
	/**
	 * Called every few hundred messages with how many have been written.
	 *
	 * A run that the runtime cuts off writes nothing at all about itself --
	 * `writeMailboxBackup` throwing is recorded, being killed is not. This is
	 * the only thing that survives such a run, so it must not be able to take
	 * the backup down with it; the caller swallows its failures.
	 */
	onProgress?: (messages: number) => Promise<void>,
): Promise<BackupResult> {
	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
	const ids = await stub.listEmailIdsByDate();

	const folderNames = new Map<string, string>();
	for (const folder of await stub.getFolders()) {
		folderNames.set(String(folder.id), String(folder.name));
	}

	const key = backupKey(mailboxId, now);
	const upload = await env.BUCKET.createMultipartUpload(key);
	const buffer = new PartBuffer();
	const parts: R2UploadedPart[] = [];
	let messages = 0;
	let bytes = 0;

	try {
		let reported = 0;
		// A page at a time. The ids were taken in date order above and the read
		// gives them back in that order, so the archive is written in the same
		// order it always was.
		for (let from = 0; from < ids.length; from += READ_BATCH) {
			const page = await stub.getEmailsByIds(
				ids.slice(from, from + READ_BATCH),
			);

			for (const batch of renderBatches(page)) {
				const rendered = await Promise.all(
					batch.map((email) => {
						const folderId = String(
							(email as { folder_id?: string }).folder_id ?? "inbox",
						);
						return renderMboxEntry(
							env,
							email as never,
							folderNames.get(folderId) ?? folderId,
						);
					}),
				);

				// Appended in the order they were asked for, whatever order they
				// came back in: Promise.all keeps the array's positions. The
				// archive is written in date order and has to stay that way --
				// a reordering here is invisible until somebody restores from it.
				for (const entry of rendered) {
					buffer.add(entry);
					bytes += entry.byteLength;
					messages += 1;

					// A loop, not an `if`: one message with a large attachment can
					// fill several parts at once.
					while (buffer.size >= PART_SIZE) {
						parts.push(
							await upload.uploadPart(parts.length + 1, buffer.take(PART_SIZE)),
						);
					}
				}
			}

			if (onProgress && messages - reported >= PROGRESS_EVERY) {
				reported = messages;
				await onProgress(messages).catch(() => {});
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
