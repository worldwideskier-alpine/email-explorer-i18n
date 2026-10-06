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
	REMINDER,
	replyTexts,
	rowsFromTail,
	runHook,
	textsBeforeTools,
} from "../../../../.claude/hooks/reply-rules-judge.mjs";
import CLAUDE_MD from "../../../../CLAUDE.md?raw";

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
				"変更は packages/worker/src/index.ts と CLAUDE.md の 2 つです。Deploy Worker の Current Version ID も載せます。",
			),
		).toEqual([]);
	});

	it("passes what has no prose in it: code, a link, a bare word", () => {
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

	it("sends back English that carries only a Japanese label", () => {
		// What a slipping reply actually looks like: the label stays Japanese.
		expect(
			finalReplyProblems(
				`${JAPANESE_REPLY}\n3. **確認:** The deploy log shows the new version and all checks passed.`,
			),
		).toHaveLength(1);
		expect(
			finalReplyProblems(
				`${JAPANESE_REPLY}\nPR #65 は merged, deployed, and verified on production.`,
			),
		).toHaveLength(1);
	});

	it("reads names as names, however many", () => {
		// Measured on this repository's own replies: a line like this was sent
		// back when every English word counted (five names, three kana).
		expect(
			finalReplyProblems(
				`${JAPANESE_REPLY}\n3. Deploy Worker ログの Current Version ID：\`661a54ec\``,
			),
		).toEqual([]);
	});

	it("draws the line at five English words", () => {
		const line = (english: string) =>
			finalReplyProblems(`${JAPANESE_REPLY}\n${english}`);
		expect(line("one two three four")).toEqual([]);
		expect(line("one two three four five")).toHaveLength(1);
	});

	it("leaves English alone where it is quoted, as code or as a quote", () => {
		const fenced = `${JAPANESE_REPLY}\n\n\`\`\`\nEvery PR passed CI and the pre-merge check.\n\`\`\``;
		const inline = `${JAPANESE_REPLY}\nコミットの題は次のとおりです。\n   \`Make a legacy password hash cost what a current one does\``;
		const quoted = `${JAPANESE_REPLY}\n実際のエラーです。\n> TypeError: Cannot read properties of undefined (reading 'id')`;
		expect(finalReplyProblems(fenced)).toEqual([]);
		expect(finalReplyProblems(inline)).toEqual([]);
		expect(finalReplyProblems(quoted)).toEqual([]);
	});

	it("finds a fence however deep it sits", () => {
		const indented = `${JAPANESE_REPLY}\n10. 次を実行します。\n    \`\`\`bash\n    git commit -m "Fix the thing that broke the build again"\n    \`\`\``;
		const inQuote = `${JAPANESE_REPLY}\n> \`\`\`\n> Fix the thing that broke the build again\n> \`\`\``;
		expect(finalReplyProblems(indented)).toEqual([]);
		expect(finalReplyProblems(inQuote)).toEqual([]);
		// and reads what follows a closed fence again
		expect(
			finalReplyProblems(
				`${JAPANESE_REPLY}\n\`\`\`\ncode\n\`\`\`\nEvery PR passed CI and the pre-merge check.`,
			),
		).toHaveLength(1);
	});

	it("does not count names: paths, links, tags, a screen's menu path", () => {
		const reply = [
			JAPANESE_REPLY,
			"3. packages/worker/src/index.ts",
			"4. [Fix the build on main again today](https://github.com/owner/repo/pull/1)",
			'5. <img alt="a picture of the deploy log here">',
			"6. https://github.com/owner/repo/settings/secrets/actions （Settings → Secrets and variables → Actions）",
		].join("\n");
		expect(finalReplyProblems(reply)).toEqual([]);
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
	it("passes numbered items with notes indented to their text", () => {
		expect(finalReplyProblems(JAPANESE_REPLY)).toEqual([]);
		expect(
			finalReplyProblems("10. 十番目です。\n    - 十番目の補足です。"),
		).toEqual([]);
	});

	it("sends back a mark at any depth, and a dash Markdown shows as an item", () => {
		for (const reply of [
			"残りは次のとおりです。\n・F6 の直し方",
			"1. 残り\n   ・F6 の直し方",
			"残りは次のとおりです。\n■ F6 の直し方",
			"残りは次のとおりです。\n※ F6 の直し方",
			"残りは次のとおりです。\n- F6 の直し方",
			"残りは次のとおりです。\n* F6 の直し方",
			"残りは次のとおりです。\n+ F6 の直し方",
			"残りは次のとおりです。\n－ F6 の直し方",
			"残りは次のとおりです。\n– F6 の直し方",
			// short of the item's text, so an item of its own
			"1. 残り\n  - F6 の直し方",
			"10. 残り\n   - F6 の直し方",
		]) {
			expect(finalReplyProblems(reply), reply).toHaveLength(1);
		}
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

	it("sends back a number used twice in one reply, in any of its forms", () => {
		expect(finalReplyProblems("1. 一つ目です。\n1. もう一つ目です。")).toEqual([
			"番号 1 が、同じ返答の中で二度使われています。",
		]);
		for (const second of [
			"**1. 太字の一つ目です。**",
			"1) もう一つ目です。",
			"(1) もう一つ目です。",
			"（1）もう一つ目です。",
			"１．もう一つ目です。",
			"① もう一つ目です。",
			"1.もう一つ目です。",
		]) {
			expect(
				finalReplyProblems(`1. 一つ目です。\n${second}`),
				second,
			).toHaveLength(1);
		}
		// The failure that started the rule: headings 2 and 3 over items 1 to 7.
		expect(itemNumbers("## 2. 閉じる\n\n1. 一つ目\n2. 二つ目")).toEqual([
			2, 1, 2,
		]);
	});

	it("does not read a number in a sentence as an item", () => {
		expect(
			itemNumbers(
				"3 件です。\n3.14 倍です。\n2026.10.06 の夜です。\nv2.1.291 です。",
			),
		).toEqual([]);
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

	it("ignores numbers in code, and leaves numbering out of progress lines", () => {
		expect(
			finalReplyProblems("1. 手順です。\n```\n1. not an item\n```"),
		).toEqual([]);
		expect(progressProblems("1. 調べます。\n1. 直します。")).toEqual([]);
	});
});

describe("what the hook answers", () => {
	it("sends a broken final reply back, and stops after MAX_REWRITES", () => {
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

	it("allows two rewrites, as CLAUDE.md tells the owner", () => {
		expect(MAX_REWRITES).toBe(2);
		expect(CLAUDE_MD).toContain("二回まで");
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
	});

	it("tells how to show English on purpose, wherever it speaks", () => {
		expect(REMINDER).toContain("コードブロック");
		expect(
			decideProgress(["Now running the tests."])?.hookSpecificOutput
				.additionalContext,
		).toContain("コードブロック");
	});
});

// Transcript rows the way Claude Code writes them: each names its parent.
let uuid = 0;
function chainOf(
	prompt: { promptId: string; text: string },
	...messages: object[]
) {
	const root = {
		type: "user",
		uuid: `u${++uuid}`,
		promptId: prompt.promptId,
		message: { content: prompt.text },
	};
	const rows: object[] = [root];
	let parent = root.uuid;
	for (const m of messages) {
		const row = { uuid: `u${++uuid}`, parentUuid: parent, ...m };
		rows.push(row);
		parent = row.uuid;
	}
	return rows;
}
const say = (text: string, extra: object = {}) => ({
	type: "assistant",
	message: { id: `m${uuid}`, model: "main", content: [{ type: "text", text }] },
	...extra,
});
const callTool = (id: string, messageId: string) => ({
	type: "assistant",
	message: {
		id: messageId,
		model: "main",
		content: [{ type: "tool_use", id }],
	},
});

describe("reading the transcript", () => {
	it("takes the reply from the prompt that started it, not the one before", () => {
		const rows = [
			...chainOf(
				{ promptId: "p1", text: "前の指示です。" },
				say("前の返答です。"),
			),
			...chainOf(
				{ promptId: "p2", text: "今の指示です。" },
				say("1. 先に答えます。"),
				say("2. 続きです。"),
			),
		];
		expect(replyTexts(rows, "p2")).toEqual([
			"1. 先に答えます。",
			"2. 続きです。",
		]);
		expect(replyTexts(rows, "p9")).toBeNull();
	});

	it("leaves out rows that do not descend from the prompt", () => {
		// Measured in this repository's sessions: the security-guidance
		// plugin's review is an SDK session on the same model, and a `claude
		// -p` run started from the session shares its id and its file. Only
		// the chain of parents tells their rows from the reply's.
		const reply = chainOf(
			{ promptId: "p3", text: "今の指示です。" },
			say("1. 先に答えます。"),
		);
		const review = chainOf(
			{ promptId: "r1", text: "Review this diff." },
			say("1. I found no security vulnerabilities in this change."),
		);
		const rows = [...reply, ...review];
		const last = reply[reply.length - 1] as { uuid: string };
		rows.push({
			uuid: "after",
			parentUuid: last.uuid,
			...say("2. 続きです。"),
		});
		expect(replyTexts(rows, "p3")).toEqual([
			"1. 先に答えます。",
			"2. 続きです。",
		]);
	});

	it("takes the text written in the same message as the tool calls, whoever's model", () => {
		const rows = [
			...chainOf(
				{ promptId: "p4", text: "指示です。" },
				...Array.from({ length: 5 }, (_, i) => say(`途中です ${i}。`)),
				{
					type: "assistant",
					message: {
						id: "mx",
						model: "other",
						content: [{ type: "text", text: "Now running the tests." }],
					},
				},
				{
					type: "assistant",
					message: {
						id: "mx",
						model: "other",
						content: [{ type: "tool_use", id: "t1" }],
					},
				},
			),
		];
		expect(textsBeforeTools(rows, ["t1"])).toEqual(["Now running the tests."]);
		expect(textsBeforeTools(rows, ["t9"])).toEqual([]);
		expect(textsBeforeTools([callTool("t2", "m2")], ["t2"])).toEqual([]);
	});

	it("drops the row a cut tail starts inside, and rows still being written", () => {
		expect(rowsFromTail('l": 1}\n{"a":1}\n{"b":', true)).toEqual([{ a: 1 }]);
		expect(rowsFromTail('{"a":1}\n{"b":2}\n', false)).toEqual([
			{ a: 1 },
			{ b: 2 },
		]);
	});
});

describe("the hook as a whole", () => {
	function memoryIo(rows: object[] = [], env: Record<string, string> = {}) {
		const state = new Map<string, unknown>();
		return {
			state,
			io: {
				env,
				readRows: () => rows,
				readState: (key: string) => (state.get(key) as object) ?? null,
				writeState: (key: string, value: unknown) => void state.set(key, value),
			},
		};
	}
	const stopInput = (finalText: string, extra: object = {}) => ({
		hook_event_name: "Stop",
		prompt_id: "p",
		transcript_path: "t",
		last_assistant_message: finalText,
		...extra,
	});

	it("takes a faithful rewrite, numbered as the version it replaces", () => {
		const english =
			"1. The deploy succeeded on the first try.\n2. All three checks passed on the pull request.";
		const rewrite =
			"1. デプロイは一度で成功しました。\n2. プルリクエストの検査は三つとも通りました。";
		const { io } = memoryIo();
		expect(runHook(stopInput(english), io)).not.toBeNull();
		// The sent-back version is in the transcript by now.
		const rows = chainOf({ promptId: "p", text: "指示です。" }, say(english));
		const after = { ...io, readRows: () => rows };
		expect(
			runHook(stopInput(rewrite, { stop_hook_active: true }), after),
		).toBeNull();
	});

	it("does not count the final message against itself once it is in the file", () => {
		const final = "1. 一つ目です。\n2. 二つ目です。";
		const { io } = memoryIo(
			chainOf({ promptId: "p", text: "指示です。" }, say(final)),
		);
		expect(runHook(stopInput(final), io)).toBeNull();
	});

	it("warns about the text written before a batch of tools", () => {
		const rows = chainOf(
			{ promptId: "p", text: "指示です。" },
			{
				type: "assistant",
				message: {
					id: "mb",
					content: [{ type: "text", text: "Now running the tests." }],
				},
			},
			{
				type: "assistant",
				message: { id: "mb", content: [{ type: "tool_use", id: "tb" }] },
			},
		);
		const { io } = memoryIo(rows);
		const batch = {
			hook_event_name: "PostToolBatch",
			transcript_path: "t",
			tool_calls: [{ tool_use_id: "tb" }],
		};
		expect(runHook(batch, io)).toMatchObject({
			hookSpecificOutput: { hookEventName: "PostToolBatch" },
		});
		expect(
			runHook({ ...batch, tool_calls: [{ tool_use_id: "other" }] }, io),
		).toBeNull();
	});

	it("counts rewrites per prompt and stops at the cap", () => {
		const { io, state } = memoryIo();
		expect(runHook(stopInput("Merging now."), io)).not.toBeNull();
		expect(runHook(stopInput("Still merging."), io)).not.toBeNull();
		expect(runHook(stopInput("Merged it now."), io)).toBeNull();
		expect(state.get("p")).toMatchObject({ rewrites: 2 });
		// the next prompt starts again
		expect(
			runHook(stopInput("Merging now.", { prompt_id: "q" }), io),
		).not.toBeNull();
	});

	it("without a prompt id, checks the final message alone and sends it back once", () => {
		const { io } = memoryIo(
			chainOf({ promptId: "old", text: "前の指示" }, say("1. 前の返答")),
		);
		expect(
			runHook(stopInput("1. 今の返答です。", { prompt_id: undefined }), io),
		).toBeNull();
		expect(
			runHook(stopInput("Merging now.", { prompt_id: undefined }), io),
		).not.toBeNull();
		expect(
			runHook(
				stopInput("Merging now.", {
					prompt_id: undefined,
					stop_hook_active: true,
				}),
				io,
			),
		).toBeNull();
	});

	it("sends back once at most when the count cannot be kept", () => {
		const { io } = memoryIo();
		const failing = {
			...io,
			writeState: () => {
				throw new Error("read-only");
			},
		};
		expect(runHook(stopInput("Merging now."), failing)).not.toBeNull();
		expect(
			runHook(stopInput("Merging now.", { stop_hook_active: true }), failing),
		).toBeNull();
	});

	it("stays out of a subagent's way, and out of a run turned off", () => {
		const { io } = memoryIo();
		const off = memoryIo([], { REPLY_RULES: "off" }).io;
		expect(
			runHook(stopInput("Merging now.", { agent_id: "a1" }), io),
		).toBeNull();
		for (const event of ["UserPromptSubmit", "PostToolBatch", "Stop"]) {
			expect(
				runHook(
					{
						...stopInput("Merging now."),
						hook_event_name: event,
						tool_calls: [{ tool_use_id: "t" }],
					},
					off,
				),
			).toBeNull();
		}
		expect(runHook({ hook_event_name: "UserPromptSubmit" }, io)).toMatchObject({
			hookSpecificOutput: { additionalContext: REMINDER },
		});
	});

	it("answers nothing to input it cannot make sense of", () => {
		const { io } = memoryIo();
		for (const input of [
			null,
			[],
			"x",
			{},
			{ hook_event_name: "Other" },
			{ hook_event_name: "PostToolBatch", tool_calls: "x" },
		]) {
			expect(runHook(input, io)).toBeNull();
		}
	});
});
