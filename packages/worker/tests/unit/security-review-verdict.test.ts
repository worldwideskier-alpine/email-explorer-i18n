import { describe, expect, it } from "vitest";
// Plain JS on purpose: it runs under node, from .claude/security-review.sh.
import { reviewVerdict } from "../../../../.claude/security-review-verdict.mjs";

/**
 * The separate session's security review counts only if it ran and said
 * something. On Claude Code 2.1.312 the bare `claude -p "/security-review"`
 * ran no turn and printed nothing with exit status 0 -- the same, from
 * outside, as a review that found nothing.
 */

const init = JSON.stringify({ type: "system", subtype: "init" });
const said = (text: string) =>
	JSON.stringify({
		type: "assistant",
		message: { content: [{ type: "text", text }] },
	});
const result = (fields: Record<string, unknown>) =>
	JSON.stringify({
		type: "result",
		subtype: "success",
		is_error: false,
		num_turns: 5,
		result: "No findings at confidence 8 or above.",
		...fields,
	});

describe("a separate session's security review", () => {
	it("counts when the session ran and gave its verdict", () => {
		const transcript = [init, said("reading the diff"), result({})].join("\n");
		expect(reviewVerdict(transcript)).toEqual({
			ok: true,
			review: "No findings at confidence 8 or above.",
		});
	});

	it("fails the run that reviewed nothing, as the bare command's did", () => {
		// That run's result line, measured: no turn, no token, 0.3 s.
		const transcript = [
			init,
			result({ num_turns: 0, result: "", total_cost_usd: 0, duration_ms: 323 }),
		].join("\n");
		const verdict = reviewVerdict(transcript);
		expect(verdict.ok).toBe(false);
		expect(verdict).toMatchObject({
			reason: expect.stringContaining("no turn"),
		});
	});

	it("fails a session that ran but gave no verdict", () => {
		const verdict = reviewVerdict(
			[init, said("x"), result({ result: "  \n" })].join("\n"),
		);
		expect(verdict).toMatchObject({
			ok: false,
			reason: expect.stringContaining("no verdict"),
		});
	});

	it("fails a session that ended in an error, or without a result", () => {
		expect(
			reviewVerdict(result({ is_error: true, subtype: "error_max_turns" })),
		).toMatchObject({ ok: false, reason: expect.stringContaining("error") });
		expect(
			reviewVerdict(result({ subtype: "error_during_execution" })),
		).toMatchObject({ ok: false });
		expect(reviewVerdict([init, said("x")].join("\n"))).toMatchObject({
			ok: false,
			reason: expect.stringContaining("without a result"),
		});
		expect(reviewVerdict("")).toMatchObject({ ok: false });
	});

	it("reads past lines that are not JSON", () => {
		const transcript = ["warning: something", init, result({})].join("\n");
		expect(reviewVerdict(transcript).ok).toBe(true);
	});
});
