import { describe, expect, it } from "vitest";
import {
	backoffMs,
	isRetryableStatus,
	retryAfterMs,
} from "../../src/claude-spam-filter";

/**
 * Which failures are worth asking about again.
 *
 * The check fails open, so a failure is not an error anybody sees -- it is a
 * message going into the inbox unclassified, and nothing looks at it again.
 * That makes "did we ask again?" the whole question for the failures that
 * would have answered differently a second later.
 *
 * `529 overloaded_error` is the one that has been happening: Anthropic saying
 * it is busy this second. It clears on its own, and there was no retry at all.
 */

describe("what is worth asking again", () => {
	// The reason this file exists. 529 is not in the Messages API's error
	// vocabulary as a client mistake -- it is the server saying "not now".
	it("retries an overloaded API", () => {
		expect(isRetryableStatus(529)).toBe(true);
	});

	it("retries the rest of the server's own failures", () => {
		for (const status of [500, 502, 503, 504]) {
			expect([status, isRetryableStatus(status)]).toEqual([status, true]);
		}
	});

	// Not errors about the request either: a timeout and a conflict are both
	// about when it arrived.
	it("retries a timeout and a conflict", () => {
		expect(isRetryableStatus(408)).toBe(true);
		expect(isRetryableStatus(409)).toBe(true);
	});

	it("retries a rate limit", () => {
		expect(isRetryableStatus(429)).toBe(true);
	});

	/**
	 * And stops at the ones that are about this request. A key that is not
	 * valid is not valid the second time either; asking again spends the
	 * budget to arrive at the same answer, and delays the message doing it.
	 */
	it("does not retry anything the request itself caused", () => {
		for (const status of [400, 401, 403, 404, 413, 422]) {
			expect([status, isRetryableStatus(status)]).toEqual([status, false]);
		}
	});
});

describe("how long to wait", () => {
	it("doubles", () => {
		const noJitter = () => 0;
		expect(backoffMs(1, noJitter)).toBe(500);
		expect(backoffMs(2, noJitter)).toBe(1000);
		expect(backoffMs(3, noJitter)).toBe(2000);
	});

	/**
	 * Mail arrives in bursts. Without the noise, a burst that meets an
	 * overloaded API waits the identical 500ms and asks again in the same
	 * instant -- which is the shape of a request that stays overloaded.
	 */
	it("adds noise, so a burst does not retry in lockstep", () => {
		expect(backoffMs(1, () => 0)).not.toBe(backoffMs(1, () => 0.99));
		expect(backoffMs(1, () => 0.99)).toBeLessThan(750);
	});
});

describe("the API's own answer to when", () => {
	it("is honoured when it gives one", () => {
		expect(retryAfterMs("2")).toBe(2000);
		expect(retryAfterMs(" 1 ")).toBe(1000);
		expect(retryAfterMs("0")).toBe(0);
	});

	it("is ignored when there is none, or it is not a number", () => {
		expect(retryAfterMs(null)).toBeNull();
		expect(retryAfterMs("")).toBeNull();
		// The HTTP-date form of the header. Unparsed rather than misread as 0,
		// which would turn "wait" into "immediately".
		expect(retryAfterMs("Wed, 02 Sep 2026 21:29:00 GMT")).toBeNull();
		expect(retryAfterMs("-1")).toBeNull();
	});

	/**
	 * A minute is longer than the whole budget. Honouring it would spend the
	 * budget asleep and never ask again, which is strictly worse than the
	 * backoff this code would have chosen.
	 */
	it("is ignored when it asks for longer than there is", () => {
		expect(retryAfterMs("60")).toBeNull();
		expect(retryAfterMs("5")).toBe(5000);
		expect(retryAfterMs("6")).toBeNull();
	});
});
