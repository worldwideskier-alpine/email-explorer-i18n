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
 * everything after them is handed back untouched, so a message keeps the exact
 * bytes it was received with.
 */

export interface MboxEntry {
	/** The message itself, with our own headers and mbox escaping removed. */
	raw: string;
	/** Folder name, from the backup. Falls back to the inbox. */
	folder: string;
	id?: string;
	date?: string;
	read: boolean;
	starred: boolean;
}

const OUR_HEADER = /^X-Email-Explorer-([A-Za-z]+):[ \t]*(.*)$/;

/**
 * mboxrd escaping, undone: the writer prefixed any body line that looked like
 * a separator with ">", and prefixed an already-quoted one again, so removing
 * one ">" from each returns the original bytes exactly.
 */
function unescapeFromLines(message: string): string {
	return message.replace(/^>(>*From )/gm, "$1");
}

/**
 * An mbox message begins at a line starting "From " at the very start of a
 * line. Lines inside a body that would look like one are escaped (above), so
 * splitting on this is safe for a file this fork wrote.
 */
function splitEntries(text: string): string[] {
	const lines = text.split(/\r?\n/);
	const entries: string[] = [];
	let current: string[] | null = null;

	for (const line of lines) {
		if (line.startsWith("From ")) {
			if (current) entries.push(current.join("\r\n"));
			current = [];
			continue;
		}
		current?.push(line);
	}
	if (current) entries.push(current.join("\r\n"));

	return entries.filter((entry) => entry.trim() !== "");
}

function parseEntry(entry: string): MboxEntry {
	const lines = entry.split("\r\n");
	const meta = new Map<string, string>();

	// Our headers are written first, ahead of the message, so reading stops at
	// the first line that is not one of them rather than scanning the whole
	// message -- a real header of the same shape further down is not ours.
	let index = 0;
	while (index < lines.length) {
		const match = OUR_HEADER.exec(lines[index]);
		if (!match) break;
		meta.set(match[1].toLowerCase(), match[2].trim());
		index += 1;
	}

	return {
		raw: unescapeFromLines(lines.slice(index).join("\r\n")).replace(
			/(\r\n)+$/,
			"",
		),
		folder: meta.get("folder") || "inbox",
		id: meta.get("id") || undefined,
		date: meta.get("date") || undefined,
		read: meta.get("read") === "1",
		starred: meta.get("starred") === "1",
	};
}

export function parseMbox(text: string): MboxEntry[] {
	return splitEntries(text)
		.map(parseEntry)
		.filter((entry) => entry.raw.trim() !== "");
}

/**
 * The import endpoint takes the message base64-encoded. btoa only accepts
 * code points below 256, so the text is encoded to UTF-8 bytes first --
 * otherwise any message with a non-Latin subject throws.
 */
export function toBase64(raw: string): string {
	const bytes = new TextEncoder().encode(raw);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}
