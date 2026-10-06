import { describe, expect, it } from "vitest";
import { forwardSubject, replySubject } from "./subjectPrefix";

describe("the subject of a reply", () => {
	it("gets Re: when it has none", () => {
		expect(replySubject("Hello")).toBe("Re: Hello");
		expect(replySubject("")).toBe("Re: ");
	});

	/** `AW:` came back as `Re: AW: ...`, and so did Outlook's `RE:`. */
	it("keeps a reply prefix in another language or case", () => {
		for (const subject of [
			"Re: Hello",
			"RE: Hello",
			"AW: Angebot",
			"Aw: Angebot",
			"SV: Möte",
			"Antw: Vraag",
			"Re[2]: Hello",
			"RE^3: Hello",
			"Re：こんにちは",
			"回复：你好",
			"答复: 你好",
		]) {
			expect(replySubject(subject)).toBe(subject);
		}
	});

	it("does not take a word that merely begins the same for a prefix", () => {
		expect(replySubject("Reading list")).toBe("Re: Reading list");
		expect(replySubject("Award: winners")).toBe("Re: Award: winners");
		expect(replySubject("Revenue: Q3")).toBe("Re: Revenue: Q3");
	});
});

describe("the subject of a forward", () => {
	it("gets Fwd: when it has none", () => {
		expect(forwardSubject("Hello")).toBe("Fwd: Hello");
		// A reply being forwarded is still forwarded.
		expect(forwardSubject("AW: Angebot")).toBe("Fwd: AW: Angebot");
	});

	it("keeps a forward prefix in another language or case", () => {
		for (const subject of [
			"Fwd: x",
			"FW: x",
			"Fw: x",
			"WG: x",
			"TR: x",
			"转发：x",
		]) {
			expect(forwardSubject(subject)).toBe(subject);
		}
	});
});

/**
 * Claude Security F13. With no counter, `\s*(counter)?\s*` was two runs of
 * white space side by side, and "Re" followed by a long run of spaces was
 * split between them every way there is before failing: 40,000 took 1.6
 * seconds in node, twice as many four times as long. The subject is the
 * sender's, and it is tested on reply and forward.
 */
describe("a subject with a long run of spaces", () => {
	it("is answered at once, and still gets its prefix", () => {
		const subject = `Re${" ".repeat(100_000)}y`;
		const started = performance.now();
		expect(replySubject(subject)).toBe(`Re: ${subject}`);
		expect(forwardSubject(subject)).toBe(`Fwd: ${subject}`);
		expect(performance.now() - started).toBeLessThan(500);
	});

	it("still recognises a counter with space around it", () => {
		expect(replySubject("Re [2] : hello")).toBe("Re [2] : hello");
		expect(replySubject("RE^3: hello")).toBe("RE^3: hello");
		expect(replySubject("Re  : hello")).toBe("Re  : hello");
	});
});
