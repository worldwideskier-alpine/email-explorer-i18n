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
import type { TimeLimits } from "./deadline";
import { limitedBy } from "./deadline";
import type { MailboxDO } from "./durableObject";
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
 * that sixteen. The read binds one variable per id and the runtime allows
 * exactly 100, so it splits a larger page itself; this is at the limit, not
 * "well under" it as this said before.
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
 * How many bytes a string weighs once it is encoded.
 *
 * `String.length` counts UTF-16 code units, and this budget is in bytes. Every
 * character of a Japanese body is one unit and three bytes, so a six-megabyte
 * body was costed at two: eleven of them fit a budget meant to hold eight, and
 * the isolate sees the three again. A bound that is wrong by three on exactly
 * the mail this deployment carries is not a bound.
 *
 * Counted rather than encoded, because encoding it to measure it would make a
 * copy of every body -- the cost this is here to stay under.
 */
function utf8Length(value: string): number {
	let bytes = 0;
	for (let at = 0; at < value.length; at++) {
		const code = value.charCodeAt(at);
		if (code < 0x80) bytes += 1;
		else if (code < 0x800) bytes += 2;
		else if (code >= 0xd800 && code <= 0xdbff) {
			/*
			 * A *pair* is one character in four bytes and two units. A high
			 * surrogate with nothing after it is not -- and taking the next
			 * unit anyway swallowed the character that followed it. A JSON body
			 * can carry a lone surrogate, and `"\uD800\u3042"` counted four
			 * where it encodes six, so a third of a body could go missing from
			 * the budget.
			 */
			const next = value.charCodeAt(at + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				bytes += 4;
				at++;
			} else {
				// Encoded as U+FFFD, which is three bytes like the rest here.
				bytes += 3;
			}
		} else bytes += 3;
	}
	return bytes;
}

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
	const body = typeof email.body === "string" ? utf8Length(email.body) : 0;
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

/** What the backup and the purge ask of a mailbox's object. */
export type MailboxSource = Pick<
	MailboxDO,
	| "listEmailIdsByDate"
	| "getFolders"
	| "getEmailsByIds"
	| "listSpamEmailDates"
	| "deleteEmailsIn"
>;

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
 * How much of a backup one alarm writes before handing the rest to the next.
 *
 * A mailbox's night runs in its own object's alarm, and an alarm has thirty
 * seconds of CPU and fifteen minutes of wall time, whatever the mailbox
 * weighs. Written in one go, a mailbox would one night outgrow them both: on
 * 2026-10-01 the larger of the two came to 1756 messages and 401 MB. So the
 * archive is written a slice at a time, and a slice stops once it has written
 * this much or run this long -- the upload stays open, what is not yet a whole
 * part is kept in the bucket, and the next alarm carries on from there.
 *
 * 128 MiB, because a 94 MB archive measured 4.4 s of writing all told in the
 * test pool, storage included: about a fifth of the CPU an alarm has, so the
 * slice stays well inside it on a slower machine too. Eight minutes, so a
 * slow night pauses rather than running into the deadline its calls are held
 * to, which is what failed the backup of 2026-10-01.
 */
export const SLICE_BYTES = 128 * 1024 * 1024;
export const SLICE_WALL_MS = 8 * 60_000;

/** Where a slice stops, and whether it carries on from the last one. */
export interface BackupSlice {
	/** Stop once this many bytes of archive have been written in this slice. */
	bytes: number;
	/** ...or once this moment (ms since the epoch) has passed. */
	until: number;
	/** Carry on from where the last slice of tonight's backup paused. */
	resume?: boolean;
}

/** What a paused backup needs to carry on, kept in the bucket between alarms. */
interface BackupCarry {
	/** The night it belongs to, so a stale one is never carried into another. */
	night: string;
	key: string;
	uploadId: string;
	parts: R2UploadedPart[];
	/** The messages to write, in order, as they stood when the backup began. */
	ids: string[];
	/** The position in `ids` of the next message to write. */
	next: number;
	messages: number;
	bytes: number;
	/** Bytes written but not yet a whole part, kept beside this as a file. */
	leftover: number;
}

/**
 * Outside the archives' prefix on purpose: everything under that is listed to
 * the mailbox's holder as a backup they can download, and taken as an archive
 * by the spam purge.
 */
const carryKey = (mailboxId: string) => `backup-carry/${mailboxId}.json`;
const leftoverKey = (mailboxId: string) => `backup-carry/${mailboxId}.bin`;

/** The objects a paused backup keeps, for a deletion to take with the rest. */
export const pausedBackupKeys = (mailboxId: string) => [
	carryKey(mailboxId),
	leftoverKey(mailboxId),
];

async function saveCarry(
	env: Env,
	mailboxId: string,
	carry: BackupCarry,
	leftover: Uint8Array,
): Promise<void> {
	// The bytes first: a state naming bytes that are not there yet would be
	// carried on from, and the archive would be missing them.
	await env.BUCKET.put(leftoverKey(mailboxId), leftover);
	await env.BUCKET.put(carryKey(mailboxId), JSON.stringify(carry));
}

async function loadCarry(
	env: Env,
	mailboxId: string,
	night: string,
): Promise<{ carry: BackupCarry; leftover: Uint8Array }> {
	const stored = await env.BUCKET.get(carryKey(mailboxId));
	const carry = stored ? await stored.json<BackupCarry>() : null;
	if (!carry || carry.night !== night) {
		throw new Error("The paused backup's place was not found.");
	}
	const bytes = await env.BUCKET.get(leftoverKey(mailboxId));
	const leftover = bytes
		? new Uint8Array(await bytes.arrayBuffer())
		: new Uint8Array();
	// Short by even a byte and the archive would be quietly corrupt.
	if (leftover.byteLength !== carry.leftover) {
		throw new Error("The paused backup's unwritten bytes were not found.");
	}
	return { carry, leftover };
}

async function dropCarry(env: Env, mailboxId: string): Promise<void> {
	await env.BUCKET.delete([carryKey(mailboxId), leftoverKey(mailboxId)]);
}

/**
 * Gives up a paused backup: its upload aborted and its place forgotten. For a
 * night that will not carry on -- ended by the runtime, replaced by the next
 * one, or too long to finish. Nothing to do when nothing was paused.
 */
export async function abandonPausedBackup(
	env: Env,
	mailboxId: string,
): Promise<void> {
	const stored = await env.BUCKET.get(carryKey(mailboxId));
	if (!stored) return;
	const carry = await stored.json<BackupCarry>().catch(() => null);
	if (carry) {
		await env.BUCKET.resumeMultipartUpload(carry.key, carry.uploadId)
			.abort()
			.catch(() => {});
	}
	await dropCarry(env, mailboxId);
}

/** A slice's outcome: the archive is done, or it paused and will carry on. */
export type BackupStep =
	| { kind: "done"; result: BackupResult }
	| { kind: "paused"; messages: number };

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
	onProgress?: (messages: number) => Promise<void>,
	progressEvery: number = PROGRESS_EVERY,
	limits: TimeLimits = {},
	source?: MailboxSource,
): Promise<BackupResult> {
	const step = await stepMailboxBackup(
		env,
		mailboxId,
		now,
		keep,
		onProgress,
		progressEvery,
		limits,
		source,
	);
	if (step.kind === "paused") {
		throw new Error("A backup with no slice paused.");
	}
	return step.result;
}

/**
 * Writes the mailbox out -- all of it, or with `slice`, as much as one slice
 * holds -- and says whether it finished.
 */
export async function stepMailboxBackup(
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
	/** How many messages between reports. A test passes a small one. */
	progressEvery: number = PROGRESS_EVERY,
	/**
	 * How long any one call may take, and when the pass must be done by.
	 *
	 * Every call out of this function -- to the mailbox, to R2 -- is bounded
	 * by it. One that does not answer fails this mailbox with an error the
	 * pass records, and the upload is aborted; unbounded, the same call held
	 * the whole night until the runtime killed it, and nothing was recorded
	 * or aborted at all. See deadline.ts.
	 */
	limits: TimeLimits = {},
	/**
	 * The mailbox's own object, when this runs inside it -- its nightly
	 * alarm -- rather than calling itself through a stub. See
	 * mailbox-night.ts.
	 */
	source?: MailboxSource,
	/** Where to stop and hand on; absent, the whole archive in one go. */
	slice?: BackupSlice,
): Promise<BackupStep> {
	const bounded = limitedBy(limits);
	const call = limitedBy({ callLimitMs: limits.callLimitMs });
	const stub: MailboxSource =
		source ?? env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
	const night = now.toISOString();
	const carried = slice?.resume
		? await bounded(
				loadCarry(env, mailboxId, night),
				"reading where the backup paused",
			)
		: null;

	// Taken once, when the backup begins, and carried from slice to slice: a
	// message that arrives in between is tomorrow's, and one deleted in
	// between is simply not read back.
	const ids =
		carried?.carry.ids ??
		(await bounded(
			stub.listEmailIdsByDate(),
			"listing the mailbox's messages",
		));

	const folderNames = new Map<string, string>();
	for (const folder of await bounded(stub.getFolders(), "listing folders")) {
		folderNames.set(String(folder.id), String(folder.name));
	}

	const key = carried?.carry.key ?? backupKey(mailboxId, now);
	const upload = carried
		? env.BUCKET.resumeMultipartUpload(key, carried.carry.uploadId)
		: await bounded(
				env.BUCKET.createMultipartUpload(key),
				"starting the archive upload",
			);
	const buffer = new PartBuffer();
	if (carried) buffer.add(carried.leftover);
	const parts: R2UploadedPart[] = carried?.carry.parts ?? [];
	let messages = carried?.carry.messages ?? 0;
	let bytes = carried?.carry.bytes ?? 0;
	let next = carried?.carry.next ?? 0;
	let sliceBytes = 0;
	let paused = false;

	let reported = messages;
	try {
		// A page at a time. The ids were taken in date order above and the read
		// gives them back in that order, so the archive is written in the same
		// order it always was.
		pages: for (let from = next; from < ids.length; from += READ_BATCH) {
			const pageIds = ids.slice(from, from + READ_BATCH);
			const position = new Map(pageIds.map((id, at) => [id, from + at]));
			// Typed from the method: through the RPC stub a row of unknown
			// columns comes back as `unknown` as a whole.
			const page = (await bounded(
				stub.getEmailsByIds(pageIds),
				"reading messages from the mailbox",
			)) as Awaited<ReturnType<MailboxDO["getEmailsByIds"]>>;

			for (const batch of renderBatches(page)) {
				const rendered = await bounded(
					Promise.all(
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
					),
					"reading messages' originals and attachments",
				);

				// Appended in the order they were asked for, whatever order they
				// came back in: Promise.all keeps the array's positions. The
				// archive is written in date order and has to stay that way --
				// a reordering here is invisible until somebody restores from it.
				for (const entry of rendered) {
					buffer.add(entry);
					bytes += entry.byteLength;
					sliceBytes += entry.byteLength;
					messages += 1;

					// A loop, not an `if`: one message with a large attachment can
					// fill several parts at once.
					while (buffer.size >= PART_SIZE) {
						parts.push(
							await bounded(
								upload.uploadPart(parts.length + 1, buffer.take(PART_SIZE)),
								"uploading part of the archive",
							),
						);
					}
				}

				// By the message's own place, not by counting: a message deleted
				// since the backup began is not read back, and counting would
				// carry on one message short of where this stopped.
				const last = String(batch[batch.length - 1]?.id);
				next = (position.get(last) ?? from) + 1;
				if (
					slice &&
					next < ids.length &&
					(sliceBytes >= slice.bytes || Date.now() >= slice.until)
				) {
					paused = true;
					break pages;
				}
			}
			next = Math.min(from + READ_BATCH, ids.length);

			if (onProgress && messages - reported >= progressEvery) {
				reported = messages;
				// The per-call limit alone: a report is worth making even as the
				// pass's time runs out, and it is swallowed either way.
				await call(onProgress(messages), "recording progress").catch(() => {});
			}
		}

		if (paused) {
			const leftover = buffer.take(buffer.size);
			await call(
				saveCarry(
					env,
					mailboxId,
					{
						night,
						key,
						uploadId: upload.uploadId,
						parts,
						ids,
						next,
						messages,
						bytes,
						leftover: leftover.byteLength,
					},
					leftover,
				),
				"keeping the paused backup's place",
			);
			if (onProgress) {
				await call(onProgress(messages), "recording progress").catch(() => {});
			}
			return { kind: "paused", messages };
		}

		// The last part carries whatever is left and may be under the minimum.
		// An empty mailbox still gets an object, so "the backup ran and the
		// mailbox was empty" is distinguishable from "the backup never ran".
		if (buffer.size > 0 || parts.length === 0) {
			parts.push(
				await bounded(
					upload.uploadPart(parts.length + 1, buffer.take(buffer.size)),
					"uploading the last part of the archive",
				),
			);
		}

		await bounded(upload.complete(parts), "completing the archive");
		// The whole count, not the last few hundred's: the night's status is
		// read for how far the backup got.
		if (onProgress && messages !== reported) {
			await call(onProgress(messages), "recording progress").catch(() => {});
		}
	} catch (e) {
		// Without this the bucket keeps paying for the parts of a run that
		// never finished. The abort gets a limit of its own rather than what
		// is left of the pass's: giving up on a hung call is exactly when the
		// pass may have no time left, and the upload still wants aborting.
		// R2 also drops an upload left incomplete after seven days (the
		// bucket's default lifecycle rule), so one that cannot be aborted
		// here is not kept for ever.
		await call(upload.abort(), "aborting the archive upload").catch(() => {});
		if (carried || paused) {
			await call(
				dropCarry(env, mailboxId),
				"forgetting the paused backup",
			).catch(() => {});
		}
		throw e;
	}

	if (carried) {
		await call(dropCarry(env, mailboxId), "forgetting the paused backup").catch(
			() => {},
		);
	}

	// The archive is whole by now, and this mailbox's backup has happened.
	// Held to the deadline too, the rotation was refused at once whenever the
	// pass's time ran out just after the upload finished, and a backup that
	// was sitting in the bucket was recorded as failed and retried as if it
	// were not. So the per-call limit alone, and a rotation that fails costs
	// nothing but a spare archive: the next one removes everything beyond
	// `keep`, not one at a time.
	const removed = await call(
		rotate(env, mailboxId, keep),
		"removing old archives",
	).catch(() => 0);

	return { kind: "done", result: { key, messages, bytes, removed } };
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
