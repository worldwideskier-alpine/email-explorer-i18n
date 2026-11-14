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
 * Only on open, one message at a time: the list does not read originals.
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
