/**
 * Files picked in the compose dialog, on their way to the send API.
 *
 * The API takes each attachment as base64 in a JSON body, so the whole file
 * is read here and encoded before the request is built. That puts a real
 * ceiling on what can be attached -- the encoded copy is a third larger than
 * the file and the entire request is one JSON string -- which is why there is
 * a limit rather than a hope.
 */

export interface PendingAttachment {
	/** Only so the list can key and remove rows; never sent. */
	id: string;
	filename: string;
	type: string;
	size: number;
	/** base64, which is the shape the send API takes. */
	content: string;
}

/**
 * How much may be attached to one message, counted before encoding.
 *
 * Resend accepts 40MB per message and base64 makes 20MB of files into about
 * 27MB of JSON, so this sits inside that with room for the message itself.
 * It is also close to what receiving mail servers commonly accept: a great
 * deal of mail is rejected somewhere past 25MB, and a file that leaves here
 * only to bounce two hops away is worse than one refused up front.
 */
export const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/**
 * `btoa` needs a binary string, and building one with
 * `String.fromCharCode(...bytes)` passes every byte as an argument -- which
 * throws on anything but a small file, since argument lists are bounded. The
 * chunking is what makes this work on a real attachment.
 */
export function bytesToBase64(bytes: Uint8Array): string {
	const CHUNK = 0x8000;
	let binary = "";
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(binary);
}

export async function fileToAttachment(file: File): Promise<PendingAttachment> {
	const bytes = new Uint8Array(await file.arrayBuffer());
	return {
		id: crypto.randomUUID(),
		filename: file.name,
		// A browser leaves the type empty for extensions it does not know.
		// The API requires one, and "unknown bytes" is the honest answer.
		type: file.type || "application/octet-stream",
		size: file.size,
		content: bytesToBase64(bytes),
	};
}

export function totalAttachmentBytes(
	attachments: readonly { size: number }[],
): number {
	return attachments.reduce((sum, att) => sum + att.size, 0);
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
