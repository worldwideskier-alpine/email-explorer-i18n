/**
 * A message stored before a fix to how mail is decoded, put right when it is
 * opened.
 *
 * A message's subject and body are decoded once, at ingest, and stored as
 * text. When the decoding was wrong -- ISO-2022-JP read as the Encoding
 * Standard reads it, which put a U+FFFD between two JIS runs a sender wrote
 * one after the other (patches/postal-mime.patch) -- the stored text kept the
 * mistake after the fix. The original is kept (`raw/{id}.eml`), so it can be
 * read again.
 *
 * Read again, it is put back only if it is the stored text with one or more
 * U+FFFD taken out and nothing else changed (`onlyReplacementsTakenOut`).
 * What a fix to the decoding can take away is a replacement character; any
 * other difference -- a later change to how bodies are stored, an original
 * that is not this message's -- is left as it was, because a repair that
 * rewrote words would be a worse fault than the one it mends. A message with
 * no replacement character is not read again at all, and one whose
 * replacement characters are the sender's own is read again and left alone.
 *
 * On open, the subject and body of that one message. In a list or search
 * results, the subjects alone (`subjectsRepairedInList`), with three limits
 * that keep a list cheap: only a subject with a replacement character is
 * looked at, only the header block of its original is read (a range of the
 * object, parsed alone -- measured, 0.06 ms against 2.9 ms for a whole
 * notice-sized message and 108 ms for one with a 5 MB attachment), and no
 * more than `SUBJECTS_PER_LIST` per answer. A subject put right is written
 * back, so it is read once; one whose replacement characters are the
 * sender's own is read again each time, which is what the limit bounds.
 */

import PostalMime from "postal-mime";
import type { MailboxDO } from "./durableObject";
import { storedBodyOf, storedSubjectOf } from "./email-ingest";
import type { Env } from "./types";

const REPLACEMENT = 0xfffd;

export interface StoredText {
	subject: string | null;
	body: string | null;
}

export function hasReplacement(text: string | null | undefined): boolean {
	return typeof text === "string" && text.includes("�");
}

/**
 * Whether `reread` is `stored` with one or more U+FFFD taken out, and
 * otherwise the same, character for character and in order.
 */
export function onlyReplacementsTakenOut(
	stored: string,
	reread: string,
): boolean {
	if (reread.length >= stored.length) return false;
	let j = 0;
	for (let i = 0; i < stored.length; i++) {
		const c = stored.charCodeAt(i);
		if (j < reread.length && c === reread.charCodeAt(j)) {
			j++;
		} else if (c !== REPLACEMENT) {
			return false;
		}
	}
	return j === reread.length;
}

/** The fields of `stored` that reading `raw` again would put right. */
export async function rereadFromOriginal(
	stored: StoredText,
	raw: ArrayBuffer,
): Promise<Partial<Record<keyof StoredText, string>>> {
	const parsed = await PostalMime.parse(raw);
	const repaired: Partial<Record<keyof StoredText, string>> = {};
	const subject = storedSubjectOf(parsed);
	if (
		hasReplacement(stored.subject) &&
		onlyReplacementsTakenOut(stored.subject as string, subject)
	) {
		repaired.subject = subject;
	}
	const body = storedBodyOf(parsed);
	if (
		hasReplacement(stored.body) &&
		onlyReplacementsTakenOut(stored.body as string, body)
	) {
		repaired.body = body;
	}
	return repaired;
}

/**
 * The message as it should be shown, put right first if its original reads
 * better now. Never fails the open: anything that goes wrong leaves the
 * message as it was stored.
 */
export async function repairedOnOpen<T extends object>(
	env: Env,
	stub: DurableObjectStub<MailboxDO>,
	id: string,
	email: T,
): Promise<T> {
	// The row's columns, as the object stores them; anything that is not a
	// string is passed on as null, which then matches no stored text.
	const row = email as Partial<Record<keyof StoredText, unknown>>;
	const before: StoredText = {
		subject: typeof row.subject === "string" ? row.subject : null,
		body: typeof row.body === "string" ? row.body : null,
	};
	if (!hasReplacement(before.subject) && !hasReplacement(before.body)) {
		return email;
	}
	try {
		const raw = await env.BUCKET.get(`raw/${id}.eml`);
		if (!raw) return email;
		const repaired = await rereadFromOriginal(before, await raw.arrayBuffer());
		if (repaired.subject === undefined && repaired.body === undefined) {
			return email;
		}
		if (!(await stub.repairDecoding(id, before, repaired))) return email;
		return { ...email, ...repaired };
	} catch (e) {
		console.error(
			"reading a stored message again from its original failed:",
			e instanceof Error ? e.message : String(e),
		);
		return email;
	}
}

/** How many subjects one list or search answer reads originals for. */
export const SUBJECTS_PER_LIST = 5;

/**
 * How much of an original is read for its header block. One that runs past
 * this is left as it is: a header cut short would not be the subject.
 */
export const HEADER_BYTES = 64 * 1024;

/**
 * The rows of a list or search answer, with the subjects their originals
 * read better now put right and written back. Never fails the answer.
 */
export async function subjectsRepairedInList<T extends object>(
	env: Env,
	stub: DurableObjectStub<MailboxDO>,
	rows: T[],
): Promise<T[]> {
	const wanted: { index: number; id: string; subject: string }[] = [];
	for (const [index, row] of rows.entries()) {
		if (wanted.length >= SUBJECTS_PER_LIST) break;
		const { id, subject } = row as { id?: unknown; subject?: unknown };
		if (typeof id === "string" && typeof subject === "string") {
			if (hasReplacement(subject)) wanted.push({ index, id, subject });
		}
	}
	if (wanted.length === 0) return rows;

	const answered = rows.slice();
	await Promise.all(
		wanted.map(async ({ index, id, subject }) => {
			try {
				const reread = await subjectFromHeader(env, id);
				if (reread === undefined) return;
				if (!onlyReplacementsTakenOut(subject, reread)) return;
				if (!(await stub.repairSubject(id, subject, reread))) return;
				answered[index] = { ...rows[index], subject: reread } as T;
			} catch (e) {
				console.error(
					"reading a stored subject again from its original failed:",
					e instanceof Error ? e.message : String(e),
				);
			}
		}),
	);
	return answered;
}

/** The subject an original's header block gives now, as ingest stores it. */
async function subjectFromHeader(
	env: Env,
	id: string,
): Promise<string | undefined> {
	const object = await env.BUCKET.get(`raw/${id}.eml`, {
		range: { offset: 0, length: HEADER_BYTES },
	});
	if (!object) return undefined;
	const bytes = new Uint8Array(await object.arrayBuffer());
	const end = headerEnd(bytes);
	if (end < 0) return undefined;
	return storedSubjectOf(await PostalMime.parse(bytes.subarray(0, end)));
}

/** Where the header block ends, the empty line included, or -1. */
function headerEnd(bytes: Uint8Array): number {
	for (let i = 0; i + 1 < bytes.length; i++) {
		if (bytes[i] !== 0x0a) continue;
		if (bytes[i + 1] === 0x0a) return i + 2;
		if (bytes[i + 1] === 0x0d && bytes[i + 2] === 0x0a) return i + 3;
	}
	return -1;
}
