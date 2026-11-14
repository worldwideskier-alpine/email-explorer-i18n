import { describe, expect, it } from "vitest";
// Plain JS on purpose: it runs under node, from .claude/security-review.sh.
import { reviewVerdict } from "../../../../.claude/security-review-verdict.mjs";

/**
 * The separate session's security review counts only if it ran, ran the
 * security-review skill, and said something. On Claude Code 2.1.312 the bare
 * `claude -p "/security-review"` ran no turn and printed nothing with exit
 * status 0 -- the same, from outside, as a review that found nothing. On
 * 2.1.325 the skill was refused for want of a permission nobody was there to
 * give, and the session read the diff by hand and answered "no findings".
 */

const init = JSON.stringify({ type: "system", subtype: "init" });
const said = (text: string) =>
	JSON.stringify({
		type: "assistant",
		message: { content: [{ type: "text", text }] },
	});
const SKILL_CALL = "toolu_skill";
const called = (skill: string, id = SKILL_CALL) =>
	JSON.stringify({
		type: "assistant",
		message: {
			content: [{ type: "tool_use", id, name: "Skill", input: { skill } }],
		},
	});
const answered = (content: unknown, isError?: boolean, id = SKILL_CALL) =>
	JSON.stringify({
		type: "user",
		message: {
			content: [
				{
					type: "tool_result",
					tool_use_id: id,
					content,
					...(isError === undefined ? {} : { is_error: isError }),
				},
			],
		},
	});
// The two answers measured on 2.1.325: run, and refused.
const skillRan = [
	called("security-review"),
	answered("Launching skill: security-review"),
];
const REFUSAL =
	"Execute skill: security-review. The user can add the allow rule Skill(security-review) to .claude/settings.local.json to let it run without asking.";
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
		const transcript = [
			init,
			...skillRan,
			said("reading the diff"),
			result({}),
		].join("\n");
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
			[init, ...skillRan, said("x"), result({ result: "  \n" })].join("\n"),
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
		const transcript = [
			"warning: something",
			init,
			...skillRan,
			"42",
			"null",
			result({}),
		].join("\n");
		expect(reviewVerdict(transcript).ok).toBe(true);
	});

	it("fails the session that was refused the skill and reviewed by hand", () => {
		// 2026-11-13, Claude Code 2.1.325: refused, then a hand-read verdict.
		const transcript = [
			init,
			called("security-review"),
			answered(REFUSAL, true),
			said(
				"The security-review skill was not allowed to run, so I read the diff by hand.",
			),
			result({ result: "No findings at confidence 8/10 or above." }),
		].join("\n");
		expect(reviewVerdict(transcript)).toMatchObject({
			ok: false,
			reason: expect.stringContaining("refused the security-review skill"),
		});
		expect(reviewVerdict(transcript)).toMatchObject({
			reason: expect.stringContaining("Execute skill: security-review."),
		});
	});

	it("fails the session that never asked for the skill", () => {
		const transcript = [init, said("reading the diff"), result({})].join("\n");
		expect(reviewVerdict(transcript)).toMatchObject({
			ok: false,
			reason: expect.stringContaining("never ran the security-review skill"),
		});
	});

	it("does not count another skill, or a result for another call", () => {
		const otherSkill = [
			init,
			called("claude-security:scan", "toolu_other"),
			answered(
				"Launching skill: claude-security:scan",
				undefined,
				"toolu_other",
			),
			result({}),
		].join("\n");
		expect(reviewVerdict(otherSkill).ok).toBe(false);

		const answeredElsewhere = [
			init,
			called("security-review"),
			answered("Launching skill: security-review", false, "toolu_unrelated"),
			result({}),
		].join("\n");
		expect(reviewVerdict(answeredElsewhere)).toMatchObject({
			ok: false,
			reason: expect.stringContaining("never answered"),
		});
	});

	it("counts the skill once it ran, after a refusal", () => {
		const transcript = [
			init,
			called("security-review", "toolu_first"),
			answered([{ type: "text", text: REFUSAL }], true, "toolu_first"),
			called("security-review", "toolu_second"),
			answered("Launching skill: security-review", false, "toolu_second"),
			result({}),
		].join("\n");
		expect(reviewVerdict(transcript).ok).toBe(true);
	});

	it("reads the skill's run from the transcript's shape, not its words", () => {
		const transcript = [
			init,
			called("security-review"),
			answered([{ type: "text", text: "anything at all" }]),
			result({}),
		].join("\n");
		expect(reviewVerdict(transcript).ok).toBe(true);
	});
});
