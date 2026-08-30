/**
 * Base64 in, bytes out.
 *
 * `atob` returns a *string* whose character codes happen to be the bytes.
 * Handing that string to `BUCKET.put` stores its UTF-8 encoding instead of
 * those bytes, so every byte above 0x7F is written as two -- a PNG's leading
 * 0x89 becomes 0xC2 0x89, and the file no longer opens. Mail sent through
 * Resend is unaffected (the base64 is passed straight through), so the damage
 * lands only on our own copy: the download link, the mbox export and anything
 * restored from a backup.
 *
 * That is a bad failure to have, because nobody looks. The sender sees the
 * message leave and the recipient sees the file open. Every attachment test
 * before this used `test.txt`, and ASCII is exactly the input on which the
 * broken version and the correct one agree.
 */
export function base64ToBytes(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}
