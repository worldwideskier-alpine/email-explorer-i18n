import { describe, expect, it } from "vitest";
import {
	isSpamCheckFailing,
	spamCheckDetail,
	spamCheckReasonKey,
} from "./spamCheckHealth";

const AUGUST = "2026-08-28T02:33:00.000Z";
const SEPTEMBER = "2026-08-31T02:33:00.000Z";

describe("whether the second-stage check is broken now", () => {
	it("is not broken when it has never run", () => {
		expect(
			isSpamCheckFailing({
				lastSuccessAt: null,
				lastFailureAt: null,
				lastFailureReason: null,
			}),
		).toBe(false);
	});

	it("is not broken when it has only ever succeeded", () => {
		expect(
			isSpamCheckFailing({
				lastSuccessAt: SEPTEMBER,
				lastFailureAt: null,
				lastFailureReason: null,
			}),
		).toBe(false);
	});

	// The case worth catching: a key revoked, every message since going
	// straight to the inbox, and a green "configured" badge above saying
	// nothing is wrong.
	it("is broken when the last thing that happened was a failure", () => {
		expect(
			isSpamCheckFailing({
				lastSuccessAt: AUGUST,
				lastFailureAt: SEPTEMBER,
				lastFailureReason: "unauthorized",
			}),
		).toBe(true);
	});

	/**
	 * And the case worth not crying wolf about. A warning that stays on
	 * screen forever after one blip is a warning nobody reads, so a failure
	 * with a success after it is over.
	 */
	it("is not broken when it recovered", () => {
		expect(
			isSpamCheckFailing({
				lastSuccessAt: SEPTEMBER,
				lastFailureAt: AUGUST,
				lastFailureReason: "timeout",
			}),
		).toBe(false);
	});

	it("is broken when it has failed and never once succeeded", () => {
		expect(
			isSpamCheckFailing({
				lastSuccessAt: null,
				lastFailureAt: AUGUST,
				lastFailureReason: "unauthorized",
			}),
		).toBe(true);
	});

	it("copes with nothing at all", () => {
		expect(isSpamCheckFailing(null)).toBe(false);
		expect(isSpamCheckFailing(undefined)).toBe(false);
	});
});

describe("the reason shown for a failure", () => {
	it("has a message for every code the Worker records", () => {
		for (const reason of [
			"unauthorized",
			"forbidden",
			"blocked",
			"rateLimited",
			"serverError",
			"timeout",
			"network",
			"malformed",
		]) {
			expect(spamCheckReasonKey(reason)).toBe(
				`settings.spamCheck${reason[0]!.toUpperCase()}${reason.slice(1)}`,
			);
		}
	});

	/**
	 * These two were one code, and the advice for them is opposite: 401 is
	 * answered by entering the right key, 403 is not answered by entering any
	 * key at all. Sharing a message would send half the readers to re-type a
	 * key that was already correct.
	 */
	it("does not tell a refused key and a refused permission apart by luck", () => {
		expect(spamCheckReasonKey("forbidden")).not.toBe(
			spamCheckReasonKey("unauthorized"),
		);
		expect(spamCheckReasonKey("forbidden")).not.toBe(
			spamCheckReasonKey("something-new"),
		);
	});

	/**
	 * And the third, which is neither. A 401 or 403 the API did not send means
	 * the request never reached it, so there is nothing about the key or its
	 * workspace to change -- and sending the reader to check either of them is
	 * the same wrong turn, one step further on.
	 */
	it("keeps a refusal that never reached the API separate from both", () => {
		const distinct = new Set([
			spamCheckReasonKey("unauthorized"),
			spamCheckReasonKey("forbidden"),
			spamCheckReasonKey("blocked"),
		]);
		expect(distinct.size).toBe(3);
		expect(spamCheckReasonKey("blocked")).not.toBe(
			spamCheckReasonKey("something-new"),
		);
	});

	/**
	 * A screen running against a newer Worker.
	 *
	 * The fallback used to be "the API returned an error", called the vaguest
	 * of the messages. It is not vague -- it is a specific claim, and it was
	 * wrong the first time it mattered: the Worker had learnt to say "the
	 * request never reached the API", the screen had not, and the screen
	 * announced the opposite of what had happened. A code we cannot read may
	 * only produce a message that says the check failed.
	 */
	it("says only that it failed for a code it does not know", () => {
		expect(spamCheckReasonKey("something-new")).toBe(
			"settings.spamCheckUnknown",
		);
		expect(spamCheckReasonKey(null)).toBe("settings.spamCheckUnknown");
	});

	// The specific mistake, kept as its own case: an unknown code must never
	// borrow the words of a known one.
	it("does not answer an unknown code with another reason's message", () => {
		const known = [
			"unauthorized",
			"forbidden",
			"blocked",
			"rateLimited",
			"serverError",
			"timeout",
			"network",
			"malformed",
		].map(spamCheckReasonKey);
		expect(known).not.toContain(spamCheckReasonKey("something-new"));
	});
});

/**
 * "The answer could not be read" says nothing anyone can act on, and the
 * answer itself is gone by the time anyone looks -- a Worker keeps no logs.
 * So the reply is kept and shown, and this is when.
 */
describe("the reply shown beside the reason", () => {
	const failing = {
		lastSuccessAt: "2026-09-01T03:13:00.000Z",
		lastFailureAt: "2026-09-01T06:46:00.000Z",
		lastFailureReason: "malformed",
	};

	it("shows what came back instead of a verdict", () => {
		expect(
			spamCheckDetail({
				...failing,
				lastFailureDetail: "Based on the sender domain, this is SPAM",
			}),
		).toBe("Based on the sender domain, this is SPAM");
	});

	// The failure is over. Its reply is not a warning about anything that is
	// still happening, and the reason line is already hidden.
	it("says nothing once a later check has succeeded", () => {
		expect(
			spamCheckDetail({
				lastSuccessAt: "2026-09-01T07:00:00.000Z",
				lastFailureAt: "2026-09-01T06:46:00.000Z",
				lastFailureReason: "malformed",
				lastFailureDetail: "Based on the sender domain, this is SPAM",
			}),
		).toBeNull();
	});

	it("says nothing when the failure had no reply to keep", () => {
		expect(spamCheckDetail({ ...failing, lastFailureDetail: null })).toBeNull();
		expect(spamCheckDetail({ ...failing, lastFailureDetail: "  " })).toBeNull();
		expect(spamCheckDetail(failing)).toBeNull();
	});

	it("says nothing when nothing has failed", () => {
		expect(spamCheckDetail(null)).toBeNull();
	});
});
