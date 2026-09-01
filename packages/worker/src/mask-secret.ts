/**
 * A stored secret, shown the way the API console that issued it shows it:
 * `sk-ant-api03-SCW...0gAA`.
 *
 * "Configured" is not enough to act on. A key that was deleted upstream, and
 * one that is working, produce exactly the same badge, so the only way to find
 * out which key is stored has been to overwrite it and wait for the next
 * message. The head and tail are what the console lists its keys by, so
 * printing the same thing lets the two be compared by eye.
 *
 * The head is the issuer's fixed prefix plus a few characters (`sk-ant-api03-`
 * is thirteen, and every key of that kind starts with it), so what this reveals
 * of the secret itself is seven characters out of a hundred or so.
 */

const HEAD = 16;
const TAIL = 4;

/** Never show a secret so short that most of it would be on screen. */
const MIN_HIDDEN = 8;

/** The shortest secret whose last few characters are still mostly hidden. */
const MIN_FOR_TAIL = 12;

export function maskSecret(secret: string | null | undefined): string {
	const value = secret?.trim();
	if (!value) return "";

	if (value.length >= HEAD + TAIL + MIN_HIDDEN) {
		return `${value.slice(0, HEAD)}...${value.slice(-TAIL)}`;
	}
	// Not the shape this was written for -- a key from somewhere else, or a
	// typo saved by mistake. Show as little as still distinguishes it, and for
	// anything really short, nothing at all.
	if (value.length >= MIN_FOR_TAIL) return `...${value.slice(-TAIL)}`;
	return "...";
}
