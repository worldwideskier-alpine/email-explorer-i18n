import { describe, expect, it } from "vitest";
import { isSpamCheckFailing, spamCheckReasonKey } from "./spamCheckHealth";

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

	// A dashboard running against a newer Worker. Showing the raw code, or
	// nothing, would be worse than being vague.
	it("falls back for a code it does not know", () => {
		expect(spamCheckReasonKey("something-new")).toBe(
			"settings.spamCheckServerError",
		);
		expect(spamCheckReasonKey(null)).toBe("settings.spamCheckServerError");
	});
});
