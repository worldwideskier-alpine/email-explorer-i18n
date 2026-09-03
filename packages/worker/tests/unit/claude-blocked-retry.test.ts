import { describe, expect, it } from "vitest";
import {
	failureFromResponse,
	isRetryableFailure,
	isRetryableStatus,
	upstreamFailureDetail,
} from "../../src/claude-spam-filter";

/**
 * The 403 that keeps coming back, and the hole the first retry left for it.
 *
 * Retrying was added for `529 overloaded_error` and decided by the HTTP status
 * alone. That is right for every status but one. A 403 is normally about this
 * request -- the API answering `permission_error` will answer it again -- so
 * the status rule excludes it. But a 403 the API did not send is not about the
 * request at all: it never reached Anthropic. The classifier already separates
 * the two and calls the second one `blocked`.
 *
 * So the one failure whose entire description is "it comes and goes" was the
 * one given a single attempt. Measured on the live mailbox: mail classified at
 * 09:39, `403 forbidden` at 14:01, same key untouched in between.
 */

const apiError = (type: string) =>
	JSON.stringify({ type: "error", error: { type, message: "refused" } });

describe("the refusal that never reached the API", () => {
	// The production body, verbatim in shape: JSON, and `forbidden` is not a
	// word the Messages API uses for an error type.
	it("is classified as blocked, not as a permission problem", () => {
		expect(failureFromResponse(403, apiError("forbidden"))).toBe("blocked");
		expect(failureFromResponse(403, apiError("permission_error"))).toBe(
			"forbidden",
		);
	});

	it("is retried, though its status alone says not to", () => {
		expect(isRetryableStatus(403)).toBe(false);
		expect(isRetryableFailure(403, "blocked")).toBe(true);
	});

	/**
	 * And the refusal the API really did send is still answered once. Asking
	 * again for a workspace that is not allowed this call spends the budget to
	 * arrive at the same answer, and delays the message doing it.
	 */
	it("does not drag the API's own refusals into the retry", () => {
		expect(isRetryableFailure(403, "forbidden")).toBe(false);
		expect(isRetryableFailure(401, "unauthorized")).toBe(false);
	});

	// The rest of the rule is unchanged: what was retryable by status still is.
	it("leaves every other status deciding as it did", () => {
		expect(isRetryableFailure(529, "serverError")).toBe(true);
		expect(isRetryableFailure(429, "rateLimited")).toBe(true);
		expect(isRetryableFailure(400, "serverError")).toBe(false);
	});
});

/**
 * Who is refusing has never been recorded, which is why this has stayed a
 * mystery across every occurrence: `403 forbidden` is enough to know it did
 * not come from the Messages API, and not enough to know where it did come
 * from. Anthropic's edge, a proxy in front of it, and Cloudflare's own egress
 * all look identical without these.
 */
describe("what answered", () => {
	const headers = (init: Record<string, string>) => new Headers(init);

	it("names the server and the Cloudflare ray when they are there", () => {
		expect(
			upstreamFailureDetail(
				403,
				apiError("forbidden"),
				headers({ server: "cloudflare", "cf-ray": "9a1b2c3d4e5f6789-NRT" }),
			),
		).toBe("403 forbidden [server=cloudflare cf-ray=9a1b2c3d4e5f6789-NRT]");
	});

	it("says nothing extra when the refuser identified itself with neither", () => {
		expect(upstreamFailureDetail(403, apiError("forbidden"), headers({}))).toBe(
			"403 forbidden",
		);
		expect(upstreamFailureDetail(403, apiError("forbidden"))).toBe(
			"403 forbidden",
		);
	});

	/**
	 * A header is written by whoever refused us, and this line is stored and
	 * then shown on a screen. It is trimmed to a safe alphabet and a short
	 * length for the same reason the rest of the detail never quotes a body.
	 */
	it("does not put an upstream's choice of characters on the screen", () => {
		const detail = upstreamFailureDetail(
			403,
			apiError("forbidden"),
			headers({
				server: '<script>alert("x")</script>',
				"cf-ray": "a".repeat(90),
			}),
		);
		expect(detail).not.toContain("<");
		expect(detail).not.toContain('"');
		expect(detail.length).toBeLessThan(120);
	});
});
