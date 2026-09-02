/**
 * Reads an mbox file back into the messages it holds.
 *
 * The counterpart of the Worker's mbox.ts. Splitting happens here, in the
 * browser, rather than by posting the whole file: a mailbox's archive can be
 * far larger than a Worker may hold, and going a message at a time means a
 * restore reports progress and can be resumed where it stopped instead of
 * failing whole.
 *
 * Only the X-Email-Explorer-* headers this fork writes are read off the top;
 * everything after them is handed back untouched.
 *
 * All of it works on bytes. It used to work on a string, and the claim that a
 * message kept the exact bytes it was received with was false the moment the
 * file was read: `file.text()` decodes as UTF-8, and plenty of Japanese mail
 * is 8-bit Shift_JIS or EUC-JP, which is not. Every such byte came back as
 * U+FFFD, and re-encoding it to send onward made that permanent. Fixing the
 * writer alone would have been half a fix -- an archive restored through here
 * would have been destroyed on the way back in.
 *
 * Only ASCII is ever compared against, and no multi-byte mail encoding puts an
 * ASCII byte in a trailing position, so scanning bytes is safe whatever the
 * message turns out to be.
 */

export interface MboxEntry {
	/**
	 * The message itself, with our own headers and mbox escaping removed --
	 * the bytes as they arrived, not a decoding of them.
	 */
	raw: Uint8Array;
	/** Folder name, from the backup. Falls back to the inbox. */
	folder: string;
	id?: string;
	date?: string;
	read: boolean;
	starred: boolean;
}

const GT = 0x3e; // ">"
const CR = 0x0d;
const LF = 0x0a;
/** "From " -- the five bytes that begin an mbox separator line. */
const FROM = [0x46, 0x72, 0x6f, 0x6d, 0x20];

const OUR_HEADER = /^X-Email-Explorer-([A-Za-z]+):[ \t]*(.*)$/;

/** Line ranges as [start, endExclusive), the end being before any CR LF. */
interface Line {
	/** Where the line's own text starts. */
	start: number;
	/** Where its text ends, before CR/LF. */
	end: number;
	/** Where the next line starts, after CR/LF. */
	next: number;
}

function* lines(bytes: Uint8Array): Generator<Line> {
	let start = 0;
	while (start <= bytes.length) {
		let end = start;
		while (end < bytes.length && bytes[end] !== LF) end++;
		const next = end + 1;
		if (end > start && bytes[end - 1] === CR) end--;
		yield { start, end, next };
		if (next > bytes.length) return;
		start = next;
	}
}

/** Whether a line begins an mbox entry: "From " at the very start. */
function isSeparator(bytes: Uint8Array, line: Line): boolean {
	if (line.end - line.start < FROM.length) return false;
	return FROM.every((b, k) => bytes[line.start + k] === b);
}

/**
 * mboxrd escaping, undone: the writer prefixed any body line that looked like
 * a separator with ">", and prefixed an already-quoted one again, so removing
 * one ">" from each returns the original bytes exactly.
 */
function unescapeFromLines(bytes: Uint8Array): Uint8Array {
	const dropAt: number[] = [];

	for (const line of lines(bytes)) {
		if (bytes[line.start] !== GT) continue;
		let p = line.start;
		while (p < line.end && bytes[p] === GT) p++;
		if (
			line.end - p >= FROM.length &&
			FROM.every((b, k) => bytes[p + k] === b)
		) {
			dropAt.push(line.start);
		}
	}

	if (dropAt.length === 0) return bytes;

	const out = new Uint8Array(bytes.length - dropAt.length);
	let read = 0;
	let write = 0;
	for (const at of dropAt) {
		out.set(bytes.subarray(read, at), write);
		write += at - read;
		read = at + 1;
	}
	out.set(bytes.subarray(read), write);
	return out;
}

/**
 * The blank line the writer puts after every message, removed -- and only
 * that one.
 *
 * The old code stripped every trailing newline, which quietly ate blank lines
 * a message genuinely ended with. The writer appends exactly one CR LF CR LF,
 * so exactly that comes off; a file some other client wrote falls back to the
 * looser trim, since there is nothing to be exact about.
 */
function trimWriterPadding(bytes: Uint8Array): Uint8Array {
	const n = bytes.length;
	if (
		n >= 4 &&
		bytes[n - 4] === CR &&
		bytes[n - 3] === LF &&
		bytes[n - 2] === CR &&
		bytes[n - 1] === LF
	) {
		return bytes.subarray(0, n - 4);
	}
	let end = n;
	while (end > 0 && (bytes[end - 1] === LF || bytes[end - 1] === CR)) end--;
	return bytes.subarray(0, end);
}

const decoder = new TextDecoder();

function parseEntry(bytes: Uint8Array): MboxEntry {
	const meta = new Map<string, string>();

	// Our headers are written first, ahead of the message, so reading stops at
	// the first line that is not one of them rather than scanning the whole
	// message -- a real header of the same shape further down is not ours.
	// They are the one part of the file this fork wrote itself, so decoding
	// them as UTF-8 is reading back exactly what was written.
	let bodyStart = 0;
	for (const line of lines(bytes)) {
		const match = OUR_HEADER.exec(
			decoder.decode(bytes.subarray(line.start, line.end)),
		);
		if (!match) break;
		meta.set(match[1].toLowerCase(), match[2].trim());
		bodyStart = line.next;
	}

	return {
		raw: unescapeFromLines(trimWriterPadding(bytes.subarray(bodyStart))),
		folder: meta.get("folder") || "inbox",
		id: meta.get("id") || undefined,
		date: meta.get("date") || undefined,
		read: meta.get("read") === "1",
		starred: meta.get("starred") === "1",
	};
}

/** Whether anything here is more than whitespace worth sending on. */
function hasContent(bytes: Uint8Array): boolean {
	for (const byte of bytes) {
		if (byte !== 0x20 && byte !== 0x09 && byte !== CR && byte !== LF) {
			return true;
		}
	}
	return false;
}

/**
 * An mbox message begins at a line starting "From " at the very start of a
 * line. Lines inside a body that would look like one are escaped (above), so
 * splitting on this is safe for a file this fork wrote.
 */
export function parseMbox(bytes: Uint8Array): MboxEntry[] {
	const entries: MboxEntry[] = [];
	let bodyStart: number | null = null;

	const push = (end: number) => {
		if (bodyStart === null) return;
		const body = bytes.subarray(bodyStart, end);
		if (hasContent(body)) entries.push(parseEntry(body));
	};

	for (const line of lines(bytes)) {
		if (!isSeparator(bytes, line)) continue;
		push(line.start);
		bodyStart = line.next;
	}
	push(bytes.length);

	return entries.filter((entry) => hasContent(entry.raw));
}

/**
 * The import endpoint takes the message base64-encoded.
 *
 * Straight from the bytes. It used to take a string and encode it to UTF-8
 * first, which was correct for the string it was given and useless anyway --
 * that string had already lost whatever was not UTF-8 before it got here.
 */
export function toBase64(raw: Uint8Array): string {
	let binary = "";
	for (const byte of raw) binary += String.fromCharCode(byte);
	return btoa(binary);
}
