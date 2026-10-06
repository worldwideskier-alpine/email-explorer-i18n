import { describe, expect, it } from "vitest";
// The rules CLAUDE.md sets for replies to the owner, as the hook in
// .claude/hooks applies them. Plain JS on purpose: the hook runs under node.
import {
	decideProgress,
	decideStop,
	finalReplyProblems,
	itemNumbers,
	MAX_REWRITES,
	progressProblems,
	replyTexts,
	textsBeforeTools,
} from "../../../../.claude/hooks/reply-rules-judge.mjs";

/**
 * Each rule is asked from both sides: the reply that must pass, and the one
 * that must be sent back. A checker that only ever said "fine" would pass
 * every test of the first kind, and one that sent everything back would
 * stop the work -- both have to be ruled out.
 */

const JAPANESE_REPLY = [
	"PR #64 をマージし、本番に入れました。",
	"",
	"1. CI、マージ前の検査、別セッションのレビューをすべて通りました。",
	"2. Current Version ID は `e48d8d8c-9c82-45db-98a0-db4a63a6d438` です。",
	"   - 確認は Deploy Worker のログで行いました。",
].join("\n");

describe("language", () => {
	it("passes a Japanese reply, identifiers and all", () => {
		expect(finalReplyProblems(JAPANESE_REPLY)).toEqual([]);
		expect(
			finalReplyProblems(
				"変更は packages/worker/src/index.ts と CLAUDE.md の 2 つです。Current Version ID も載せます。",
			),
		).toEqual([]);
	});

	it("passes what has no prose in it: code, a link, a bare number", () => {
		expect(
			finalReplyProblems(
				"```\nnpm run build && wrangler deploy --dry-run\n```",
			),
		).toEqual([]);
		expect(finalReplyProblems("https://github.com/owner/repo/pull/64")).toEqual(
			[],
		);
		expect(finalReplyProblems("OK")).toEqual([]);
	});

	it("sends back a reply with no Japanese in it, however short", () => {
		expect(finalReplyProblems("Merging now.")).toHaveLength(1);
		expect(
			finalReplyProblems(
				"All 7 fixes from the proposal are now in production.",
			)[0],
		).toContain("日本語が一文字もありません");
	});

	it("sends back an English sentence inside a Japanese reply", () => {
		const reply = `${JAPANESE_REPLY}\nEvery PR passed CI and the pre-merge check.`;
		expect(finalReplyProblems(reply)).toEqual([
			"英語の行があります（「Every PR passed CI and the pre-merge check.」）。",
		]);
	});

	it("leaves English alone where it is quoted as code", () => {
		const fenced = `${JAPANESE_REPLY}\n\n\`\`\`\nEvery PR passed CI and the pre-merge check.\n\`\`\``;
		const inline = `${JAPANESE_REPLY}\nコミットの題は次のとおりです。\n   \`Make a legacy password hash cost what a current one does\``;
		expect(finalReplyProblems(fenced)).toEqual([]);
		expect(finalReplyProblems(inline)).toEqual([]);
	});

	it("reads a table by its rows", () => {
		expect(
			finalReplyProblems(
				"| PR | 指摘 | 変えたこと |\n|---|---|---|\n| #57 | F3 | リンク整形 |",
			),
		).toEqual([]);
		expect(
			finalReplyProblems(
				"| PR | Finding | What changed |\n|---|---|---|\n| #57 | F3 | Link formatting no longer freezes the tab |",
			),
		).not.toEqual([]);
	});
});

describe("items", () => {
	it("passes numbered items with indented notes under them", () => {
		expect(finalReplyProblems(JAPANESE_REPLY)).toEqual([]);
	});

	it("sends back a 中黒 at any depth, and a bullet at the margin", () => {
		expect(
			finalReplyProblems("残りは次のとおりです。\n・F6 の直し方"),
		).toHaveLength(1);
		expect(finalReplyProblems("1. 残り\n   ・F6 の直し方")).toHaveLength(1);
		expect(
			finalReplyProblems("残りは次のとおりです。\n- F6 の直し方"),
		).toHaveLength(1);
		expect(
			finalReplyProblems("残りは次のとおりです。\n* F6 の直し方"),
		).toHaveLength(1);
	});

	it("does not take a rule line or a fenced list for an item", () => {
		expect(
			finalReplyProblems("ここまでが前半です。\n\n---\n\n* * *\n\n後半です。"),
		).toEqual([]);
		expect(
			finalReplyProblems(
				"設定は次のとおりです。\n```yaml\n- run: pnpm test\n```",
			),
		).toEqual([]);
	});
});

describe("numbers", () => {
	it("passes numbers used once each", () => {
		expect(
			finalReplyProblems(
				"1. 一つ目です。\n2. 二つ目です。\n\n**3. 三つ目です。**",
			),
		).toEqual([]);
	});

	it("sends back a number used twice in one reply", () => {
		expect(finalReplyProblems("1. 一つ目です。\n1. もう一つ目です。")).toEqual([
			"番号 1 が、同じ返答の中で二度使われています。",
		]);
		// The failure that started the rule: headings 2 and 3 over items 1 to 7.
		expect(itemNumbers("## 2. 閉じる\n\n1. 一つ目\n2. 二つ目")).toEqual([
			2, 1, 2,
		]);
	});

	it("sends back a numbered heading", () => {
		expect(finalReplyProblems("## 2. 閉じるもの\n\n3. 一つ目です。")).toEqual([
			"見出しに番号が付いています（「## 2. 閉じるもの」）。",
		]);
		expect(finalReplyProblems("## 残っているもの\n\n3. 一つ目です。")).toEqual(
			[],
		);
	});

	it("counts the numbers an earlier message of the same reply already used", () => {
		const earlier = [
			"先にお答えします。\n\n1. 誤りではありません。\n2. 読んでいても守れていませんでした。",
		];
		expect(finalReplyProblems("1. 実装しました。", earlier)).toHaveLength(1);
		expect(finalReplyProblems("3. 実装しました。", earlier)).toEqual([]);
	});

	it("ignores numbers in code", () => {
		expect(
			finalReplyProblems("1. 手順です。\n```\n1. not an item\n```"),
		).toEqual([]);
	});
});

describe("what the hook answers", () => {
	it("sends a broken final reply back, and stops sending it back after MAX_REWRITES", () => {
		const broken = { finalText: "Merging now.", earlierTexts: [] };
		const sentBack = { hookSpecificOutput: { hookEventName: "Stop" } };
		expect(decideStop({ ...broken, rewrites: 0 })).toMatchObject(sentBack);
		expect(decideStop({ ...broken, rewrites: MAX_REWRITES - 1 })).toMatchObject(
			sentBack,
		);
		expect(decideStop({ ...broken, rewrites: MAX_REWRITES })).toBeNull();
		// Not a block: that is shown to the owner as a hook error.
		expect(decideStop({ ...broken, rewrites: 0 })).not.toHaveProperty(
			"decision",
		);
	});

	it("lets a reply that keeps the rules end the turn", () => {
		expect(
			decideStop({ finalText: JAPANESE_REPLY, earlierTexts: [], rewrites: 0 }),
		).toBeNull();
	});

	it("never blocks between tool calls, only says what went wrong", () => {
		const answer = decideProgress(["Now running the tests."]);
		expect(answer).not.toHaveProperty("decision");
		expect(answer?.hookSpecificOutput.additionalContext).toContain(
			"Now running the tests.",
		);
		expect(decideProgress(["試験を走らせます。"])).toBeNull();
		expect(progressProblems("試験を走らせます。")).toEqual([]);
	});
});

describe("reading the transcript", () => {
	const row = (type: string, content: unknown, extra: object = {}) => ({
		type,
		message: { content, ...extra },
		...extra,
	});
	const rows = [
		row("user", "前の指示です。", { promptId: "p1" }),
		row("assistant", [{ type: "text", text: "前の返答です。" }]),
		row("user", "今の指示です。", { promptId: "p2" }),
		row("assistant", [{ type: "text", text: "1. 先に答えます。" }], {
			id: "m1",
		}),
		row("assistant", [{ type: "tool_use", id: "t1" }], { id: "m1" }),
		row("user", [{ type: "tool_result", tool_use_id: "t1" }], {
			promptId: "p2",
		}),
		row("assistant", [{ type: "text", text: "2. 続きです。" }], { id: "m2" }),
	];

	it("takes the reply from the prompt that started it, not the one before", () => {
		expect(replyTexts(rows, "p2")).toEqual([
			"1. 先に答えます。",
			"2. 続きです。",
		]);
		expect(replyTexts(rows, "p9")).toBeNull();
	});

	it("leaves out what other models wrote inside the session", () => {
		// Measured in this repository's own sessions: the security-guidance
		// plugin's review is recorded as assistant rows attributed to a skill,
		// on another model, and its numbered findings are not the reply's.
		const main = { model: "main-model" };
		const withSideQueries = [
			row("user", "今の指示です。", { promptId: "p3" }),
			row("assistant", [{ type: "text", text: "1. 先に答えます。" }], main),
			row("assistant", [{ type: "text", text: "1. Finding one" }], {
				model: "other-model",
				attributionSkill: "security-review",
			}),
			// A skill can also run on the main agent's own model.
			row("assistant", [{ type: "text", text: "2. Finding two" }], {
				...main,
				attributionSkill: "security-review",
			}),
			row("assistant", [{ type: "text", text: "Yes" }], {
				model: "other-model",
			}),
			row("assistant", [{ type: "text", text: "You've hit your limit" }], {
				model: "<synthetic>",
				isApiErrorMessage: true,
			}),
			row("assistant", [{ type: "text", text: "2. 続きです。" }], main),
		];
		expect(replyTexts(withSideQueries, "p3")).toEqual([
			"1. 先に答えます。",
			"2. 続きです。",
		]);
	});

	it("takes the text written in the same message as the tool calls", () => {
		expect(textsBeforeTools(rows, ["t1"])).toEqual(["1. 先に答えます。"]);
		expect(textsBeforeTools(rows, ["t9"])).toEqual([]);
	});
});
