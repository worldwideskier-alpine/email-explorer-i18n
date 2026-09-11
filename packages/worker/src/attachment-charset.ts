/**
 * The charset a text attachment arrived with.
 *
 * postal-mime hands back a bare `mimeType` -- "text/plain", with the
 * parameters dropped -- so by the time ingestion writes the row, a
 * `text/plain; charset=Shift_JIS` attachment is indistinguishable from a UTF-8
 * one. Everything downstream rebuilds the type from that row: the download
 * route's `Content-Type`, the archive of a message that has no raw copy, and
 * the part a forward would send. None of them can put back what was never
 * written down.
 *
 * The message itself still says, though. It is stored whole at
 * `raw/{id}.eml`, and the part headers in it are ASCII. So rather than guess
 * from the bytes -- Shift_JIS and EUC-JP and CP1252 are not guessable apart
 * with any confidence, and guessing wrong is worse than not knowing -- this
 * reads the declaration back out of the raw message at ingest, while it is
 * already in hand.
 *
 * Read from the bytes rather than from a decoded string on purpose. A message
 * can be twenty megabytes, `TextDecoder` in this runtime speaks UTF-8 only
 * (which a Shift_JIS part is not), and building a JS string of the whole thing
 * to run a regex over is exactly the kind of copy that got the nightly backup
 * killed. Only header lines are decoded, and only when the message has an
 * attachment at all.
 */

import { splitParameters } from "./mbox";

/** One MIME part's headers, as far as this file cares about them. */
export interface DeclaredPart {
	/** Type and subtype, lowercased, without parameters. */
	type: string;
	/** The charset parameter as written, or null when there was none. */
	charset: string | null;
	/** Whether anything about the part says it is a file rather than a body. */
	attachmentLike: boolean;
}

const LF = 0x0a;
const CR = 0x0d;
const SPACE = 0x20;
const TAB = 0x09;
const DASH = 0x2d;

/** ASCII lowercase, leaving every non-letter byte alone. */
function lower(byte: number): number {
	return byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte;
}

function decodeAscii(bytes: Uint8Array, from: number, to: number): string {
	let out = "";
	for (let at = from; at < to; at++) out += String.fromCharCode(bytes[at]);
	return out;
}

/** Where the line beginning at `at` ends, not counting its CR. */
function endOfLine(bytes: Uint8Array, at: number): number {
	let end = at;
	while (end < bytes.length && bytes[end] !== LF) end++;
	return end > at && bytes[end - 1] === CR ? end - 1 : end;
}

function startsWith(bytes: Uint8Array, at: number, ascii: string): boolean {
	if (at + ascii.length > bytes.length) return false;
	for (let n = 0; n < ascii.length; n++) {
		if (lower(bytes[at + n]) !== ascii.charCodeAt(n)) return false;
	}
	return true;
}

function charsetOf(params: string[]): string | null {
	for (const param of params) {
		// The parameter name is matched case-insensitively -- a `CHARSET=` is
		// the same parameter -- while the value is kept exactly as written,
		// because "Shift_JIS" is not ours to rewrite.
		const match = /^\s*charset\s*=\s*"?([A-Za-z0-9._:+-]+)"?\s*$/i.exec(param);
		if (match) return match[1];
	}
	return null;
}

function hasName(params: string[]): boolean {
	return params.some((param) => /^\s*(?:file)?name\*?\s*=/i.test(param));
}

/**
 * Every MIME part of the message, in the order they appear.
 *
 * A real walk rather than a search for `Content-Type:` lines, because the
 * parts have to be told apart: a message whose body is `text/plain` and whose
 * attachment is also `text/plain` gives two identical declarations, and taking
 * the first one puts the body's charset on the file. Header blocks begin at
 * the message and after every boundary line, and end at the first empty line.
 *
 * A body line that begins with "--" is read as a boundary here, which is the
 * one thing this gets wrong without knowing the boundary strings. It costs
 * nothing: a spurious part declares no type, and a message whose parts do not
 * line up with the parser's attachments is abandoned rather than guessed at.
 */
export function declaredParts(message: Uint8Array): DeclaredPart[] {
	const parts: DeclaredPart[] = [];
	let inHeaders = true;
	let type = "";
	let charset: string | null = null;
	let named = false;
	let disposition = "";
	let seenHeader = false;

	const flush = () => {
		if (!seenHeader) return;
		parts.push({
			type,
			charset,
			attachmentLike:
				disposition.startsWith("attachment") ||
				named ||
				(disposition.startsWith("inline") && named),
		});
		type = "";
		charset = null;
		named = false;
		disposition = "";
		seenHeader = false;
	};

	let at = 0;
	while (at < message.length) {
		let end = endOfLine(message, at);
		let next = end;
		while (next < message.length && message[next] !== LF) next++;
		next += 1;

		if (inHeaders) {
			if (end === at) {
				// The empty line that ends a header block.
				flush();
				inHeaders = false;
				at = next;
				continue;
			}

			const wantsType = startsWith(message, at, "content-type:");
			const wantsDisposition = startsWith(message, at, "content-disposition:");
			if (wantsType || wantsDisposition) {
				const name = wantsType ? "content-type:" : "content-disposition:";
				let value = decodeAscii(message, at + name.length, end);
				// Folded continuation lines are part of this header.
				while (
					next < message.length &&
					(message[next] === SPACE || message[next] === TAB)
				) {
					end = endOfLine(message, next);
					value += ` ${decodeAscii(message, next, end).trim()}`;
					next = end;
					while (next < message.length && message[next] !== LF) next++;
					next += 1;
				}
				const [head, ...params] = splitParameters(value);
				seenHeader = true;
				if (wantsType) {
					type = (head ?? "").trim().toLowerCase();
					charset = charsetOf(params);
					if (hasName(params)) named = true;
				} else {
					disposition = (head ?? "").trim().toLowerCase();
					if (hasName(params)) named = true;
				}
			}
			at = next;
			continue;
		}

		// In a body: a boundary line opens the next part's headers.
		if (end - at >= 2 && message[at] === DASH && message[at + 1] === DASH) {
			inHeaders = true;
		}
		at = next;
	}
	flush();

	return parts;
}

/**
 * The charset for each attachment, in the order postal-mime returned them.
 *
 * Only when the two lists agree: the parts that look like files have to be the
 * same count as the parser's attachments, and each one's type has to match.
 * Anything else gives nothing at all.
 *
 * That is deliberately strict. The alternative is pairing by best effort, and
 * a wrong pairing does not fail loudly -- it writes somebody's Shift_JIS file
 * down as UTF-8, or the reverse, which is the exact corruption this is meant
 * to prevent. Recording nothing is what the row did before any of this, and it
 * costs only the charset of a message shaped unusually enough to disagree.
 */
export function charsetsForAttachments(
	message: Uint8Array,
	attachments: { mimeType?: string }[],
): (string | null)[] {
	const nothing = attachments.map(() => null);
	if (attachments.length === 0) return nothing;

	const files = declaredParts(message).filter((part) => part.attachmentLike);
	if (files.length !== attachments.length) return nothing;

	for (const [index, attachment] of attachments.entries()) {
		const want = (attachment.mimeType ?? "").trim().toLowerCase();
		if (files[index].type !== want) return nothing;
	}
	return files.map((file) => file.charset);
}

/**
 * The type to store for an attachment.
 *
 * Only `text/…` carries a charset: on anything else the parameter means
 * nothing, and inventing one would be a claim about somebody's file that
 * nothing checked.
 */
export function typeWithCharset(
	mimeType: string | undefined,
	charset: string | null,
): string {
	const bare = (mimeType ?? "").trim();
	if (!charset || !/^text\//i.test(bare)) return bare;
	return `${bare}; charset=${charset}`;
}
