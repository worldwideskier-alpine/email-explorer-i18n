/**
 * The attachments in the bucket, checked against the attachments the mail
 * claims to have.
 *
 * Every writer names an attachment object
 * `attachments/{emailId}/{attachmentId}/{filename}`, and every reader --
 * download, archive, delete -- rebuilds that name from the row. So the row is
 * the only way back to the object, and an object no row names is unreachable:
 * it cannot be downloaded, it will not go into an archive, and deleting the
 * message it belonged to leaves it behind.
 *
 * Two ways that has happened here:
 *
 *  - **A name that disagreed.** Ingestion used to write the key from the raw
 *    parsed value while writing `filename || "untitled"` into the row, so an
 *    attachment that arrived without a name went to `.../null` and was looked
 *    for at `.../untitled`. Fixed in the ingest path; the objects already
 *    written keep the old name. These still belong to a message somebody can
 *    open, so the answer is to move them to the name the row gives, not to
 *    delete them.
 *
 *  - **A deletion that stopped halfway.** The spam purge deletes the row
 *    first and the objects second, on purpose (see purgeMailboxSpam): the
 *    other order can leave a message that opens to nothing. The cost of that
 *    choice is that a failure in between leaves objects nothing points at.
 *
 * The second kind is deleted only when asked for separately, and the reason is
 * in `deleteUnclaimedAttachments`.
 */

import { listMailboxes } from "./mailbox-records";
import type { Env } from "./types";

const PREFIX = "attachments/";

/** R2 delete accepts up to 1000 keys per call. */
const DELETE_BATCH = 1000;

/**
 * How many objects one repair call will move.
 *
 * Each one is a read, a write and a delete, and the invocation that runs them
 * is the same size as any other. A cap turns "it stopped somewhere" into "it
 * did this many and says how many are left", which the screen can then offer
 * again.
 */
const REPAIR_LIMIT = 100;

export interface AttachmentSweep {
	/** Objects under the attachments prefix, whatever their state. */
	objects: number;
	bytes: number;
	/** A live row names exactly this object. Nothing to do. */
	matched: number;
	/** A live row names this attachment under a different filename. */
	misnamed: number;
	misnamedBytes: number;
	/** No row anywhere names this object. */
	unclaimed: number;
	unclaimedBytes: number;
	/** Keys that are not shaped like an attachment key at all. */
	unreadable: number;
}

type Parsed = { emailId: string; attachmentId: string; filename: string };

/**
 * Splits a key into the three parts it was built from.
 *
 * Only the first two separators are separators: a filename may contain a
 * slash ("report/final.pdf" is a legal name to arrive with) and splitting on
 * every slash would read its first segment as the whole name, making an
 * object look misnamed when it is not.
 */
export function parseAttachmentKey(key: string): Parsed | null {
	if (!key.startsWith(PREFIX)) return null;
	const rest = key.slice(PREFIX.length);
	const first = rest.indexOf("/");
	if (first <= 0) return null;
	const second = rest.indexOf("/", first + 1);
	if (second <= first + 1) return null;
	return {
		emailId: rest.slice(0, first),
		attachmentId: rest.slice(first + 1, second),
		filename: rest.slice(second + 1),
	};
}

export function attachmentKey(row: Parsed): string {
	return `${PREFIX}${row.emailId}/${row.attachmentId}/${row.filename}`;
}

/**
 * Every attachment every listed mailbox claims, as `emailId/attachmentId` to
 * the key that attachment should be under.
 *
 * Listed is the word that matters. A mailbox deleted without `purge` keeps its
 * Durable Object and its objects on purpose -- recreating the mailbox brings
 * the mail back -- but its record under `mailboxes/` is gone, so nothing here
 * can ask it what it holds. Its attachments therefore read as unclaimed, which
 * is why deleting those is a separate decision and not part of the sweep.
 */
async function readRows(env: Env): Promise<Map<string, string>> {
	const rows = new Map<string, string>();
	for (const mailbox of await listMailboxes(env)) {
		const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailbox.id));
		for (const row of await stub.listAttachmentRows()) {
			rows.set(`${row.emailId}/${row.attachmentId}`, attachmentKey(row));
		}
	}
	return rows;
}

type Verdict =
	| { kind: "matched" }
	| { kind: "misnamed"; expected: string }
	| { kind: "unclaimed" }
	| { kind: "unreadable" };

function classify(key: string, rows: Map<string, string>): Verdict {
	const parsed = parseAttachmentKey(key);
	if (!parsed) return { kind: "unreadable" };
	const expected = rows.get(`${parsed.emailId}/${parsed.attachmentId}`);
	if (expected === undefined) return { kind: "unclaimed" };
	if (expected === key) return { kind: "matched" };
	return { kind: "misnamed", expected };
}

/** Walks the whole prefix, a page at a time. */
async function* listAttachments(env: Env) {
	let cursor: string | undefined;
	do {
		const listed = await env.BUCKET.list({ prefix: PREFIX, cursor });
		for (const object of listed.objects) yield object;
		cursor = listed.truncated ? listed.cursor : undefined;
	} while (cursor);
}

/** Counts only. Reads no message, and names no file, mailbox or address. */
export async function surveyAttachments(env: Env): Promise<AttachmentSweep> {
	const rows = await readRows(env);
	const sweep: AttachmentSweep = {
		objects: 0,
		bytes: 0,
		matched: 0,
		misnamed: 0,
		misnamedBytes: 0,
		unclaimed: 0,
		unclaimedBytes: 0,
		unreadable: 0,
	};

	for await (const object of listAttachments(env)) {
		sweep.objects += 1;
		sweep.bytes += object.size;
		const verdict = classify(object.key, rows);
		if (verdict.kind === "matched") sweep.matched += 1;
		else if (verdict.kind === "misnamed") {
			sweep.misnamed += 1;
			sweep.misnamedBytes += object.size;
		} else if (verdict.kind === "unclaimed") {
			sweep.unclaimed += 1;
			sweep.unclaimedBytes += object.size;
		} else sweep.unreadable += 1;
	}

	return sweep;
}

export interface RepairResult {
	repaired: number;
	/** The row's name was already taken, so this object was left alone. */
	duplicates: number;
	remaining: number;
}

/**
 * Moves misnamed objects to the name their row gives.
 *
 * A copy and then a delete, in that order: the opposite order loses the only
 * copy of somebody's attachment if the invocation stops in between, and the
 * worst this way round can leave is the same object under both names, which
 * the next sweep reports as unclaimed and nobody loses anything over.
 *
 * An object is skipped when something already sits at the row's name. That is
 * the case where the attachment is already reachable and this is a second copy
 * under an old name -- deleting it would be right and is not done here, because
 * "repair" that deletes an object it never looked inside is not a repair.
 */
export async function repairMisnamedAttachments(
	env: Env,
	limit = REPAIR_LIMIT,
): Promise<RepairResult> {
	const rows = await readRows(env);
	const result: RepairResult = { repaired: 0, duplicates: 0, remaining: 0 };

	for await (const object of listAttachments(env)) {
		const verdict = classify(object.key, rows);
		if (verdict.kind !== "misnamed") continue;
		if (result.repaired >= limit) {
			result.remaining += 1;
			continue;
		}

		if (await env.BUCKET.head(verdict.expected)) {
			result.duplicates += 1;
			continue;
		}
		const stored = await env.BUCKET.get(object.key);
		// Gone between the listing and now: the next sweep will say so.
		if (!stored) continue;
		await env.BUCKET.put(verdict.expected, stored.body, {
			httpMetadata: stored.httpMetadata,
			customMetadata: stored.customMetadata,
		});
		await env.BUCKET.delete(object.key);
		result.repaired += 1;
	}

	return result;
}

export interface PurgeResult {
	deleted: number;
	bytes: number;
	remaining: number;
}

/**
 * Deletes objects no row names.
 *
 * Separate from the sweep and from the repair because this is the one step
 * that can destroy something somebody still wants. "No row names it" is read
 * from the mailboxes that are *listed*; a mailbox deleted without `purge` is
 * not listed and its mail is meant to come back when it is recreated, and
 * this cannot tell that mail from a deletion's leftovers. The screen says so,
 * and the choice is the reader's rather than a default.
 */
export async function deleteUnclaimedAttachments(
	env: Env,
	limit = DELETE_BATCH,
): Promise<PurgeResult> {
	const rows = await readRows(env);
	const result: PurgeResult = { deleted: 0, bytes: 0, remaining: 0 };
	const keys: string[] = [];

	for await (const object of listAttachments(env)) {
		if (classify(object.key, rows).kind !== "unclaimed") continue;
		if (keys.length >= limit) {
			result.remaining += 1;
			continue;
		}
		keys.push(object.key);
		result.bytes += object.size;
	}

	if (keys.length > 0) await env.BUCKET.delete(keys);
	result.deleted = keys.length;
	return result;
}
