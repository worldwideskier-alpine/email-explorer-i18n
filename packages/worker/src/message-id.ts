/**
 * A Message-ID as a reply may name it, or null.
 *
 * The value is the sender's, and a reply writes it into In-Reply-To and
 * References. postal-mime decodes RFC 2047 encoded words in those headers, so
 * `=?utf-8?Q?a=0D=0ABcc:_...?=` came out of ingest as a real line break and a
 * header of the sender's choosing, stored, and written into our outgoing mail
 * by the next reply. So an id is kept only if it has the shape of one: a
 * single `@`, nothing that separates or ends a header (whitespace, control
 * characters) and no angle brackets, which are ours to add.
 *
 * Asked at ingest, when a reply is threaded, and when the headers are
 * written, because rows stored before the first of those are still there.
 */
export function asMessageId(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const id = value.trim().replace(/^<(.*)>$/s, "$1");
	if (id.length === 0 || id.length > MAX_LENGTH) return null;
	if (/[\s\p{Cc}<>]/u.test(id)) return null;
	const at = id.indexOf("@");
	if (at <= 0 || at === id.length - 1 || id.indexOf("@", at + 1) !== -1) {
		return null;
	}
	return id;
}

/**
 * The ids a References header names, in order.
 *
 * Read by their brackets, not by splitting at whitespace: split, the injected
 * value above came apart into pieces, and one of them -- the address after
 * `Bcc:` -- had the shape of an id. A header with no brackets at all, which
 * some mailers write, is read word by word.
 */
export function messageIdsIn(header: unknown): string[] {
	if (typeof header !== "string") return [];
	const bracketed = [...header.matchAll(/<([^<>]*)>/g)].map((m) => m[1]);
	const candidates = header.includes("<") ? bracketed : header.split(/\s+/);
	return candidates.map(asMessageId).filter((id): id is string => id !== null);
}

/** RFC 5322's line limit is 998; one id comes nowhere near a fair share. */
const MAX_LENGTH = 250;
