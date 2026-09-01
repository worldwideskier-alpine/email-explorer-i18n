import { describe, expect, it } from "vitest";
import { maskSecret } from "../../src/mask-secret";

/**
 * The point of the format is comparison: what this prints has to be the same
 * shape the API console prints, or the two cannot be held side by side.
 */

// A real key's shape: the fixed prefix and a hundred-odd characters after it.
const KEY = `sk-ant-api03-SCW${"x".repeat(90)}0gAA`;

describe("maskSecret", () => {
	it("prints an API key the way its console lists it", () => {
		expect(maskSecret(KEY)).toBe("sk-ant-api03-SCW...0gAA");
	});

	it("tells two keys of the same issuer apart", () => {
		const other = `sk-ant-api03-J7w${"x".repeat(90)}mwAA`;
		expect(maskSecret(other)).toBe("sk-ant-api03-J7w...mwAA");
		expect(maskSecret(other)).not.toBe(maskSecret(KEY));
	});

	it("shows nothing for no key", () => {
		expect(maskSecret("")).toBe("");
		expect(maskSecret(null)).toBe("");
		expect(maskSecret(undefined)).toBe("");
	});

	// Whitespace around a pasted key is stripped before it is stored, but a
	// value written by anything other than the settings screen may still carry
	// it, and it must not shift what is shown.
	it("ignores surrounding whitespace", () => {
		expect(maskSecret(`  ${KEY}\n`)).toBe("sk-ant-api03-SCW...0gAA");
	});

	// Most of the secret has to stay hidden whatever its length, or this stops
	// being a mask. These are the two cases where the console's own format
	// would print more of the value than it hides.
	it("keeps most of a short secret hidden", () => {
		const twenty = "abcdefghijklmnopqrst";
		expect(maskSecret(twenty)).toBe("...qrst");
		expect(maskSecret(twenty)).not.toContain("abcdefgh");
	});

	it("shows nothing at all of a very short one", () => {
		expect(maskSecret("abcdefgh")).toBe("...");
	});
});
