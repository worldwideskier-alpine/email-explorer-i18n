import { describe, expect, it } from "vitest";
import { parseVerdict } from "../../src/claude-spam-filter";

/**
 * Reading a verdict out of the classifier's reply.
 *
 * This used to be `verdict !== "SPAM" && verdict !== "NOT_SPAM"` against the
 * whole trimmed, upper-cased reply -- so a full stop, a pair of asterisks, or
 * a single word of preamble was enough for the check to produce no verdict at
 * all. The message went to the inbox (the stage fails open, which is right)
 * and the settings screen said the answer could not be read, which is what
 * happened in production: one message on 2026-09-01 06:46, with the same key
 * working before and after.
 *
 * Two things changed. The assistant's turn is prefilled now, so the verdict is
 * the first thing the model writes; and the reply is read as words rather than
 * compared whole.
 */

describe("parseVerdict", () => {
	it("reads the bare words", () => {
		expect(parseVerdict("SPAM")).toBe("spam");
		expect(parseVerdict("NOT_SPAM")).toBe("inbox");
	});

	// What the prefilled assistant turn actually returns: the continuation of
	// "Classification:", which starts with a space.
	it("reads a reply that continues the prefilled turn", () => {
		expect(parseVerdict(" SPAM")).toBe("spam");
		expect(parseVerdict(" NOT_SPAM")).toBe("inbox");
	});

	it("ignores the punctuation a model puts around a word", () => {
		expect(parseVerdict("SPAM.")).toBe("spam");
		expect(parseVerdict('"NOT_SPAM"')).toBe("inbox");
		expect(parseVerdict("**SPAM**")).toBe("spam");
		expect(parseVerdict("`NOT_SPAM`")).toBe("inbox");
		expect(parseVerdict("\nSPAM\n")).toBe("spam");
	});

	it("does not care about case", () => {
		expect(parseVerdict("not_spam")).toBe("inbox");
		expect(parseVerdict("Spam")).toBe("spam");
	});

	/**
	 * "NOT SPAM" is the same answer as "NOT_SPAM". Reading it as a bare "NOT"
	 * would be no verdict; reading it by scanning for "SPAM" would be the
	 * opposite of what the model said, and would file a real message as spam.
	 */
	it("treats a space or a hyphen in NOT_SPAM as the same answer", () => {
		expect(parseVerdict("NOT SPAM")).toBe("inbox");
		expect(parseVerdict("NOT-SPAM")).toBe("inbox");
		expect(parseVerdict("Not spam.")).toBe("inbox");
	});

	/**
	 * The reason only the first word counts. Every one of these contains the
	 * word SPAM, and in every one the model declined to give a verdict.
	 * Reading on would file the message as spam -- losing real mail, which is
	 * the one outcome this whole stage is built to avoid.
	 */
	it("refuses a reply that does not begin with a verdict", () => {
		expect(parseVerdict("I cannot determine whether this is SPAM.")).toBeNull();
		expect(parseVerdict("Based on the sender domain, this is SPAM")).toBeNull();
		expect(parseVerdict("Is this SPAM or NOT_SPAM?")).toBeNull();
		expect(parseVerdict("Classification: SPAM")).toBeNull();
	});

	it("refuses a reply with nothing in it", () => {
		expect(parseVerdict("")).toBeNull();
		expect(parseVerdict("   \n ")).toBeNull();
	});

	// What an answer cut off by max_tokens looks like. It must not be read as
	// the word it was going to be.
	it("refuses a word that was cut off", () => {
		expect(parseVerdict("NOT_SPA")).toBeNull();
		expect(parseVerdict("SPA")).toBeNull();
	});
});
