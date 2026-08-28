/**
 * Password hashing.
 *
 * Stored hashes come in two shapes:
 *
 *   pbkdf2-sha256$<iterations>$<salt b64>$<derived key b64>   (current)
 *   <64 hex chars>                                            (legacy)
 *
 * The legacy form is an unsalted, single-round SHA-256 -- fast enough to
 * brute-force on a GPU and vulnerable to precomputed tables, since two
 * accounts with the same password store the same hash. It is still accepted
 * on login so that nobody has to reset a password, but a successful login
 * against one is reported as needing a rehash and is upgraded in place (see
 * MailboxDO.login).
 */

/**
 * Work factor for new hashes. Measured at ~17ms of CPU per verification on
 * the Workers runtime, which leaves plenty of headroom on the Workers Paid
 * plan's per-request CPU budget.
 *
 * Raising this later does not invalidate anything: the iteration count is
 * stored alongside each hash, so old hashes keep verifying at their own cost
 * and are re-derived at the new one the next time their owner logs in.
 */
export const PBKDF2_ITERATIONS = 100_000;

const PBKDF2_PREFIX = "pbkdf2-sha256";
const SALT_BYTES = 16;
const KEY_BITS = 256;

export interface PasswordVerification {
	valid: boolean;
	/**
	 * True only when the password was correct *and* the stored hash used a
	 * weaker scheme than the current one, so the caller can rewrite it.
	 */
	needsRehash: boolean;
}

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

async function deriveKey(
	password: string,
	salt: Uint8Array,
	iterations: number,
): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(password),
		"PBKDF2",
		false,
		["deriveBits"],
	);
	const bits = await crypto.subtle.deriveBits(
		{ name: "PBKDF2", hash: "SHA-256", salt, iterations },
		key,
		KEY_BITS,
	);
	return new Uint8Array(bits);
}

async function legacyHash(password: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(password),
	);
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * Compares without an early return on the first differing byte, so the time
 * taken doesn't reveal how much of a guess was correct.
 */
function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

export async function hashPassword(password: string): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
	const derived = await deriveKey(password, salt, PBKDF2_ITERATIONS);
	return [
		PBKDF2_PREFIX,
		PBKDF2_ITERATIONS,
		toBase64(salt),
		toBase64(derived),
	].join("$");
}

export async function verifyPassword(
	password: string,
	stored: string,
): Promise<PasswordVerification> {
	if (!stored.startsWith(`${PBKDF2_PREFIX}$`)) {
		const valid = timingSafeEqual(await legacyHash(password), stored);
		return { valid, needsRehash: valid };
	}

	const [, iterationsRaw, saltB64, hashB64] = stored.split("$");
	const iterations = Number(iterationsRaw);
	if (!Number.isInteger(iterations) || iterations < 1 || !saltB64 || !hashB64) {
		return { valid: false, needsRehash: false };
	}

	let salt: Uint8Array;
	try {
		salt = fromBase64(saltB64);
	} catch {
		return { valid: false, needsRehash: false };
	}

	const derived = await deriveKey(password, salt, iterations);
	const valid = timingSafeEqual(toBase64(derived), hashB64);
	// A hash written before the work factor was raised is still correct, just
	// cheaper to attack than a fresh one -- worth rewriting while we hold the
	// plaintext.
	return { valid, needsRehash: valid && iterations < PBKDF2_ITERATIONS };
}
