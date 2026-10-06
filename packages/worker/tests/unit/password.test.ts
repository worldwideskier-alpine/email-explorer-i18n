import { afterEach, describe, expect, it, vi } from "vitest";
import {
	hashPassword,
	PBKDF2_ITERATIONS,
	verifyPassword,
} from "../../src/password";

const PASSWORD = "correct-horse-battery-staple";

async function legacyHash(password: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(password),
	);
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

describe("password hashing", () => {
	it("writes the scheme and work factor into the stored hash", async () => {
		const stored = await hashPassword(PASSWORD);
		const [scheme, iterations, salt, derived] = stored.split("$");
		expect(scheme).toBe("pbkdf2-sha256");
		expect(Number(iterations)).toBe(PBKDF2_ITERATIONS);
		expect(salt.length).toBeGreaterThan(0);
		expect(derived.length).toBeGreaterThan(0);
	});

	// The whole point of the salt: two accounts that happen to share a
	// password must not share a hash, or one cracked hash cracks both and a
	// precomputed table works against the lot.
	it("produces a different hash every time for the same password", async () => {
		const a = await hashPassword(PASSWORD);
		const b = await hashPassword(PASSWORD);
		expect(a).not.toBe(b);
		expect((await verifyPassword(PASSWORD, a)).valid).toBe(true);
		expect((await verifyPassword(PASSWORD, b)).valid).toBe(true);
	});

	it("accepts the right password and refuses a wrong one", async () => {
		const stored = await hashPassword(PASSWORD);
		expect(await verifyPassword(PASSWORD, stored)).toEqual({
			valid: true,
			needsRehash: false,
		});
		expect(await verifyPassword("not-the-password", stored)).toEqual({
			valid: false,
			needsRehash: false,
		});
	});
});

describe("legacy unsalted SHA-256 hashes", () => {
	it("still verifies, and asks to be rewritten", async () => {
		const stored = await legacyHash(PASSWORD);
		expect(stored).toMatch(/^[0-9a-f]{64}$/);
		expect(await verifyPassword(PASSWORD, stored)).toEqual({
			valid: true,
			needsRehash: true,
		});
	});

	it("does not ask for a rewrite when the password was wrong", async () => {
		const stored = await legacyHash(PASSWORD);
		expect(await verifyPassword("not-the-password", stored)).toEqual({
			valid: false,
			needsRehash: false,
		});
	});
});

describe("stored hashes from an older work factor", () => {
	it("verifies at their own cost and asks to be rewritten", async () => {
		// Hand-built at a lower iteration count than the current default,
		// standing in for a hash written before the work factor was raised.
		const salt = crypto.getRandomValues(new Uint8Array(16));
		const key = await crypto.subtle.importKey(
			"raw",
			new TextEncoder().encode(PASSWORD),
			"PBKDF2",
			false,
			["deriveBits"],
		);
		const bits = await crypto.subtle.deriveBits(
			{ name: "PBKDF2", hash: "SHA-256", salt, iterations: 1000 },
			key,
			256,
		);
		const b64 = (bytes: Uint8Array) =>
			btoa(String.fromCharCode(...Array.from(bytes)));
		const stored = `pbkdf2-sha256$1000$${b64(salt)}$${b64(new Uint8Array(bits))}`;

		expect(await verifyPassword(PASSWORD, stored)).toEqual({
			valid: true,
			needsRehash: true,
		});
	});
});

describe("malformed stored hashes", () => {
	it.each([
		["pbkdf2-sha256$", "no fields"],
		["pbkdf2-sha256$abc$c2FsdA==$aGFzaA==", "a non-numeric work factor"],
		["pbkdf2-sha256$0$c2FsdA==$aGFzaA==", "a zero work factor"],
		["pbkdf2-sha256$100000$$", "empty salt and hash"],
		["pbkdf2-sha256$100000$!!!not base64!!!$aGFzaA==", "an unparseable salt"],
	])("refuses %s without throwing (%s)", async (stored) => {
		await expect(verifyPassword(PASSWORD, stored)).resolves.toEqual({
			valid: false,
			needsRehash: false,
		});
	});
});

/**
 * Claude Security F12. An address with no account costs a full PBKDF2
 * (verifyNothing), and so did one with a current hash -- but one still on
 * the unsalted SHA-256 of before answered after a single digest, and the
 * difference in time listed those accounts. Timing is not measurable in the
 * Workers runtime, whose clock stands still between I/O, so what is asked is
 * the work itself: every way a stored hash is checked derives one PBKDF2 at
 * the current work factor.
 */
describe("what checking a stored hash costs", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const roundsDerived = async (stored: string, password = PASSWORD) => {
		const derive = vi.spyOn(crypto.subtle, "deriveBits");
		derive.mockClear();
		await verifyPassword(password, stored);
		const rounds = derive.mock.calls.map(
			([algorithm]) => (algorithm as { iterations: number }).iterations,
		);
		derive.mockRestore();
		return rounds;
	};

	it("is a full PBKDF2 for a legacy hash, right or wrong", async () => {
		const stored = await legacyHash(PASSWORD);
		expect(await roundsDerived(stored)).toEqual([PBKDF2_ITERATIONS]);
		expect(await roundsDerived(stored, "wrong")).toEqual([PBKDF2_ITERATIONS]);
	});

	it("is a full PBKDF2 for a stored hash that cannot be read", async () => {
		for (const stored of [
			"pbkdf2-sha256$x$c2FsdA==$aGFzaA==",
			"pbkdf2-sha256$100000$!!!$aGFzaA==",
			"pbkdf2-sha256$100000",
		]) {
			expect(await roundsDerived(stored), stored).toEqual([PBKDF2_ITERATIONS]);
		}
	});

	it("is the same as for a current hash", async () => {
		const stored = await hashPassword(PASSWORD);
		expect(await roundsDerived(stored)).toEqual([PBKDF2_ITERATIONS]);
	});
});
