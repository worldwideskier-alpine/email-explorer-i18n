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
