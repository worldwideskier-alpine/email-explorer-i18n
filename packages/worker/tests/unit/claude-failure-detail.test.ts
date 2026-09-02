import { describe, expect, it } from "vitest";
import {
	failureFromResponse,
	upstreamFailureDetail,
} from "../../src/claude-spam-filter";

/**
 * A refusal used to leave one word behind -- "the key was rejected" -- and
 * that word cannot answer the question anyone actually has. A key that is
 * wrong and a key that is right but not permitted both produce it, and the
 * advice for the two is opposite.
 *
 * What separates them is the shape of the answer. The API replies in JSON and
 * names its own reason from a closed vocabulary; whatever stands in front of
 * it replies with a page, and never reaches the API at all. So the absence of
 * that JSON is itself the finding, and is recorded as such rather than by
 * quoting somebody else's error page onto the screen.
 */

const apiError = (type: string) =>
	JSON.stringify({ type: "error", error: { type, message: "refused" } });

describe("what is recorded about a refusal", () => {
	it("names the API's own reason for a 401", () => {
		expect(upstreamFailureDetail(401, apiError("authentication_error"))).toBe(
			"401 authentication_error",
		);
	});

	it("names the API's own reason for a 403", () => {
		expect(upstreamFailureDetail(403, apiError("permission_error"))).toBe(
			"403 permission_error",
		);
	});

	// The distinction the whole thing is for: same status, and the reason it
	// happened is not the same reason at all.
	it("separates a refusal by the API from one before it", () => {
		const page = "<html><title>Sorry, you have been blocked</title></html>";
		expect(upstreamFailureDetail(403, page)).toBe("403 (no API error body)");
		expect(upstreamFailureDetail(403, page)).not.toBe(
			upstreamFailureDetail(403, apiError("permission_error")),
		);
	});

	it("never puts somebody else's error page on the screen", () => {
		const page = "<html><body>Ray ID: 9a1f2c3d4e5f</body></html>";
		expect(upstreamFailureDetail(403, page)).not.toContain("Ray ID");
		expect(upstreamFailureDetail(403, page)).not.toContain("<");
	});

	it("copes with an empty body and with JSON that names nothing", () => {
		expect(upstreamFailureDetail(500, "")).toBe("500 (no API error body)");
		expect(upstreamFailureDetail(500, "{}")).toBe("500 (no API error body)");
		expect(upstreamFailureDetail(500, JSON.stringify({ error: {} }))).toBe(
			"500 (no API error body)",
		);
		expect(
			upstreamFailureDetail(500, JSON.stringify({ error: { type: 7 } })),
		).toBe("500 (no API error body)");
	});

	// The vocabulary is closed and short, so anything long is not one of its
	// words and has no claim on the width of the line.
	it("keeps the line short whatever comes back", () => {
		const long = apiError("x".repeat(500));
		expect(upstreamFailureDetail(403, long).length).toBeLessThan(60);
	});
});

/**
 * Which refusal this is, and the thing the first version got wrong.
 *
 * It read "JSON with an error type" as "the API answered". A 403 then arrived
 * carrying `{"error":{"type":"forbidden"}}` -- JSON, and `forbidden` is not a
 * word the Messages API uses (its 403 is `permission_error`). Read as the
 * API's own answer it became "your key is not permitted this call", pointing
 * at a console where nothing was wrong, about a key that had classified a
 * message eight minutes earlier.
 */
describe("which refusal it was", () => {
	it("believes the API when the API is the one answering", () => {
		expect(failureFromResponse(401, apiError("authentication_error"))).toBe(
			"unauthorized",
		);
		expect(failureFromResponse(403, apiError("permission_error"))).toBe(
			"forbidden",
		);
	});

	// The case from production.
	it("does not take a foreign refusal for the API's own", () => {
		expect(failureFromResponse(403, apiError("forbidden"))).toBe("blocked");
		expect(failureFromResponse(401, apiError("unauthorized"))).toBe("blocked");
	});

	it("treats a refusal with no error body the same way", () => {
		expect(failureFromResponse(403, "<html>blocked</html>")).toBe("blocked");
		expect(failureFromResponse(401, "")).toBe("blocked");
	});

	// The API's own word for it outranks the status: it is the more specific
	// statement, and it is the one the advice on screen is written against.
	it("follows the API's own name over the status", () => {
		expect(failureFromResponse(403, apiError("authentication_error"))).toBe(
			"unauthorized",
		);
		expect(failureFromResponse(401, apiError("permission_error"))).toBe(
			"forbidden",
		);
	});

	it("leaves every other status where it was", () => {
		expect(failureFromResponse(429, apiError("rate_limit_error"))).toBe(
			"rateLimited",
		);
		expect(failureFromResponse(500, apiError("api_error"))).toBe("serverError");
		expect(failureFromResponse(529, apiError("overloaded_error"))).toBe(
			"serverError",
		);
		expect(failureFromResponse(400, apiError("invalid_request_error"))).toBe(
			"serverError",
		);
	});
});
