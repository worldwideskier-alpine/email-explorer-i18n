/** The most bytes of a filename that go into an attachment's R2 key. */
const MAX_FILENAME_BYTES = 200;

/**
 * The name an attachment is stored under, in its key and in its row alike.
 *
 * The key embeds the name, and R2 refuses a key over 1024 bytes. A sender's
 * filename is the sender's to make as long as they like, so one of about 940
 * bytes made the upload throw -- after the raw copy was written, so the whole
 * message was refused and its original left behind with no row. A long name
 * is shortened on a character boundary, keeping its extension so the file
 * still opens with the right program.
 *
 * Every reader rebuilds the key from the row, so the two must be this one
 * value; see email-ingest.ts.
 */
export function storableFilename(
	name: string | null | undefined,
	maxBytes: number = MAX_FILENAME_BYTES,
): string {
	const whole = name || "untitled";
	const encoder = new TextEncoder();
	if (encoder.encode(whole).length <= maxBytes) return whole;

	const dot = whole.lastIndexOf(".");
	const extension = dot > 0 && whole.length - dot <= 16 ? whole.slice(dot) : "";
	const marker = "…";
	let room =
		maxBytes - encoder.encode(marker).length - encoder.encode(extension).length;
	let stem = "";
	for (const character of whole.slice(0, whole.length - extension.length)) {
		const size = encoder.encode(character).length;
		if (size > room) break;
		stem += character;
		room -= size;
	}
	return `${stem}${marker}${extension}`;
}
