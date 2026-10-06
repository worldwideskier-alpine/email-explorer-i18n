// What CLAUDE.md asks of the text the owner reads, written as checks a
// program makes on every reply -- because a rule the model only reads was
// broken in the same session that wrote it down: progress lines and final
// reports came out in English, and items came out as unnumbered bullets or
// with a number used twice, so the owner could not point at one.
//
// Pure functions only, no node: imports, so the worker suite can import this
// file as it imports scripts/night-check.mjs. reply-rules.mjs is the hook:
// it reads stdin, the transcript and the state files, and calls runHook.

// Hiragana, katakana and CJK ideographs. Japanese prose always has some.
const JAPANESE = /[぀-ヿㇰ-ㇿ㐀-䶿一-鿿]/g;
// Two letters or more, so "a", "F3" or "v2" do not count as English words.
const LATIN_WORD = /[A-Za-z][A-Za-z'’-]*[A-Za-z]/g;
// The same, starting in lower case: what an English sentence is made of.
// Names are capitalised -- "Deploy Worker", "Current Version ID" -- and a
// Japanese line naming three of them read as English when every word counted.
const LOWER_WORD = /(?<![A-Za-z])[a-z][A-Za-z'’-]*[A-Za-z]/g;
// A line with this many such words, and fewer Japanese characters than
// those words, is English with a Japanese label at most: "1. **確認:** The
// deploy log shows the new version and all checks passed."
const ENGLISH_LINE_WORDS = 5;
// A whole message with no Japanese and this many words is English, however
// short: "Merging now." is the kind of line that slipped through.
const ENGLISH_MESSAGE_WORDS = 2;

// A fence may sit under a list item at any depth, or inside a quote.
const FENCE = /^(?:[ \t]*>)*[ \t]*(`{3,}|~{3,})/;
const QUOTE = /^[ \t]*>/;
// Marks that make a line an item without a number. Checked after NFKC, which
// turns the full-width forms (＊ ＋ － ･) into their plain ones.
const ITEM_GLYPH = /^[ \t]*[・•‣◦●▪■□◆◇○◎※→⇒▶▷►✓✔✅☐☑★☆]/;
const DASH_ITEM = /^([ \t]*)[-*+‐‑‒–—―][ \t]+\S/;
const RULE_LINE = /^[ \t]*([-*_])([ \t]*\1){2,}[ \t]*$/;
// "1. ", "1) ", "1.準備" -- but not "3.14" or "2026.10.06".
const ORDERED_ITEM = /^([ \t]*)(\d{1,3})[.)](?!\d)([ \t]*)\S/;
const PAREN_ITEM = /^[ \t]*\((\d{1,3})\)/;
const CIRCLED_ITEM = /^[ \t]*([①-⑳])/;
const BOLD_NUMBER = /^[ \t]*\*\*(\d{1,3})[.)]/;
const NUMBERED_HEADING = /^[ \t]{0,3}#{1,6}[ \t]+\(?(\d{1,3})[.)、:]/;

/** The lines a reader sees as prose: outside code fences, each with
 * `prose` (inline code, URLs, links, HTML tags and paths taken out, since
 * those are English by nature) and `words` (the same without asides in
 * parentheses, which hold names such as a screen's English menu path). */
export function proseLines(text) {
	const out = [];
	let fence = null;
	for (const original of String(text ?? "").split(/\r?\n/)) {
		const raw = original.normalize("NFKC");
		const open = raw.match(FENCE);
		if (fence) {
			if (open && open[1][0] === fence[0] && open[1].length >= fence.length) {
				fence = null;
			}
			continue;
		}
		if (open) {
			fence = open[1];
			continue;
		}
		const prose = raw
			.replace(/`+[^`]*`+/g, " ")
			.replace(/!?\[[^\]]*\]\([^)]*\)/g, " ")
			.replace(/<https?:[^>]*>/g, " ")
			.replace(/https?:\/\/\S+/g, " ")
			.replace(/<\/?[A-Za-z][^>]*>/g, " ")
			.replace(/\S*[/\\]\S*/g, " ");
		const words = prose.replace(/\([^)]*\)/g, " ");
		out.push({ original, raw, prose, words, quote: QUOTE.test(raw) });
	}
	return out;
}

function count(re, s) {
	return s.match(re)?.length ?? 0;
}

function excerpt(s) {
	const t = s.trim();
	return t.length > 60 ? `${t.slice(0, 57)}...` : t;
}

/** Problems with the language of one message the owner will read. */
export function languageProblems(text) {
	const lines = proseLines(text);
	const all = lines.map((l) => l.prose).join("\n");
	if (
		count(JAPANESE, all) === 0 &&
		count(LATIN_WORD, all) >= ENGLISH_MESSAGE_WORDS
	) {
		const first = lines.find((l) => count(LATIN_WORD, l.prose) > 0);
		return [
			`日本語が一文字もありません（「${excerpt(first?.original ?? all)}」）。`,
		];
	}
	return lines
		.filter((l) => {
			if (l.quote) return false; // somebody else's words, quoted
			const english = count(LOWER_WORD, l.words);
			return (
				english >= ENGLISH_LINE_WORDS && count(JAPANESE, l.prose) < english
			);
		})
		.map((l) => `英語の行があります（「${excerpt(l.original)}」）。`);
}

/** Problems with how the items of one message are marked. A dash is a note
 * on the numbered item above it only when it is indented to that item's
 * text; any less, and Markdown shows it as an item of its own. */
export function bulletProblems(text) {
	const problems = [];
	let itemColumn = null;
	for (const { original, raw, quote } of proseLines(text)) {
		if (quote || !raw.trim()) continue;
		const ordered = raw.match(ORDERED_ITEM);
		if (ordered) {
			itemColumn =
				ordered[1].length +
				ordered[2].length +
				1 +
				Math.max(1, ordered[3].length);
		}
		const dash = raw.match(DASH_ITEM);
		if (ITEM_GLYPH.test(raw)) {
			problems.push(`記号で項目を立てています（「${excerpt(original)}」）。`);
		} else if (dash && !RULE_LINE.test(raw)) {
			if (itemColumn === null || dash[1].length < itemColumn) {
				problems.push(`番号のない項目があります（「${excerpt(original)}」）。`);
			}
		} else if (!ordered && !/^[ \t]/.test(raw)) {
			itemColumn = null; // a paragraph at the margin ends the list
		}
		if (NUMBERED_HEADING.test(raw)) {
			problems.push(`見出しに番号が付いています（「${excerpt(original)}」）。`);
		}
	}
	return problems;
}

/** Every item number a message shows: list items at any depth in any of
 * the usual forms, bold numbers that stand in for a heading, and numbered
 * headings. */
export function itemNumbers(text) {
	const numbers = [];
	for (const { original, raw } of proseLines(text)) {
		const circled = original.match(CIRCLED_ITEM);
		if (circled) {
			numbers.push(circled[1].codePointAt(0) - 0x245f);
			continue;
		}
		const ordered = raw.match(ORDERED_ITEM);
		const m =
			raw.match(NUMBERED_HEADING) ??
			raw.match(BOLD_NUMBER) ??
			raw.match(PAREN_ITEM);
		if (m) numbers.push(Number(m[1]));
		else if (ordered) numbers.push(Number(ordered[2]));
	}
	return numbers;
}

/** Numbers the final message uses twice, or uses again after an earlier
 * message of the same reply already did. */
export function numberProblems(finalText, earlierTexts = []) {
	const earlier = new Set(earlierTexts.flatMap(itemNumbers));
	const seen = new Set();
	const twice = new Set();
	for (const n of itemNumbers(finalText)) {
		if (seen.has(n) || earlier.has(n)) twice.add(n);
		seen.add(n);
	}
	return [...twice]
		.sort((a, b) => a - b)
		.map((n) => `番号 ${n} が、同じ返答の中で二度使われています。`);
}

/** Everything wrong with the reply that is about to end a turn. */
export function finalReplyProblems(finalText, earlierTexts = []) {
	return [
		...languageProblems(finalText),
		...bulletProblems(finalText),
		...numberProblems(finalText, earlierTexts),
	];
}

/** Everything wrong with a progress line written between tool calls. The
 * numbering is left to the final reply, which is checked as a whole. */
export function progressProblems(text) {
	return [...languageProblems(text), ...bulletProblems(text)];
}

const HOW_TO_QUOTE =
	"英語のまま見せるもの（コード、識別子、コマンド、引用したエラーや題名）は、`…` かコードブロックに入れる。";

export const REMINDER = [
	"返答の約束（CLAUDE.md）:",
	"利用者への返答と途中の報告は日本語で書く。",
	HOW_TO_QUOTE,
	"項目は通し番号で書き、記号や行頭の「-」で項目を立てない（番号付きの項目の文の位置まで字下げした補足は可）。",
	"一つの返答の中で同じ番号を二度使わず、見出しには番号を付けない。",
	"利用者の判断が要るときは、精査した推奨案を一つ示す。",
].join("\n");

const REWRITE = [
	"この返答は、CLAUDE.md の返答の約束に反しています。",
	"同じ内容を、約束どおりに書き直して、もう一度出してください（日本語、通し番号、一つの返答で番号を重ねない、見出しに番号を付けない、記号や行頭の「-」で項目を立てない）。",
	HOW_TO_QUOTE,
	"番号は、差し戻したこの版と同じでかまいません（差し戻した版は数えません）。",
	"書き直しには、謝罪や経緯の説明を足さないでください。この知らせのことも書かないでください。",
].join("\n");

// Both say not to apologise or explain: measured, a warning without that
// line came back as a paragraph of apology in the next reply, which is one
// more line the owner did not ask for.
const WARN = [
	"直前の途中報告が、CLAUDE.md の返答の約束に反していました。",
	"表示済みの行は取り消せません。次の報告から、約束どおりに書いてください。",
	HOW_TO_QUOTE,
	"この知らせのことを返答に書いたり、謝ったりはしないでください。",
].join("\n");

/** How many times one reply may be sent back for rewriting (CLAUDE.md says
 * so too). The runtime has its own cap of eight, but a rule this file gets
 * wrong would then cost eight rewrites; two is enough for a real slip. */
export const MAX_REWRITES = 2;

function listed(problems) {
	return problems.map((p, i) => `${i + 1}. ${p}`).join("\n");
}

/** The Stop hook's answer, given the final message, the earlier messages of
 * the same reply, and how many rewrites this reply has already had.
 *
 * additionalContext rather than `decision: "block"`: both keep the turn
 * going, but a block is shown to the owner as a hook error, and nothing has
 * failed -- the reply is being put right. */
export function decideStop({ finalText, earlierTexts, rewrites }) {
	const problems = finalReplyProblems(finalText, earlierTexts);
	if (problems.length === 0 || rewrites >= MAX_REWRITES) return null;
	return {
		hookSpecificOutput: {
			hookEventName: "Stop",
			additionalContext: `${REWRITE}\n\n${listed(problems)}`,
		},
	};
}

/** The PostToolBatch hook's answer for the text written just before the
 * batch: a reminder alongside the results, never a block. */
export function decideProgress(texts) {
	const problems = texts.flatMap(progressProblems);
	if (problems.length === 0) return null;
	return {
		hookSpecificOutput: {
			hookEventName: "PostToolBatch",
			additionalContext: `${WARN}\n\n${listed(problems)}`,
		},
	};
}

export function decidePrompt() {
	return {
		hookSpecificOutput: {
			hookEventName: "UserPromptSubmit",
			additionalContext: REMINDER,
		},
	};
}

/** Parsed rows of a transcript's tail. `cut` says the text starts partway
 * through the file, so its first line is the end of a row and is dropped. */
export function rowsFromTail(text, cut) {
	const lines = String(text).split("\n");
	if (cut) lines.shift();
	const rows = [];
	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			rows.push(JSON.parse(line));
		} catch {
			// a row still being written
		}
	}
	return rows;
}

function textsOf(row) {
	return row?.type === "assistant" && Array.isArray(row.message?.content)
		? row.message.content
				.filter((c) => c?.type === "text")
				.map((c) => String(c.text))
		: [];
}

/** The texts of one reply: the assistant rows that descend from the prompt
 * that started it. Measured in this repository's sessions, the same file
 * also holds rows that descend from elsewhere -- the security-guidance
 * plugin's review (an SDK session on the same model), and `claude -p` runs
 * started from the session, which share its id -- and only the chain of
 * parents tells them apart. Null when the prompt is not in `rows`. */
export function replyTexts(rows, promptId) {
	const start = rows.findIndex(
		(r) =>
			r?.type === "user" &&
			r.promptId === promptId &&
			(typeof r.message?.content === "string" ||
				r.message?.content?.some?.((c) => c?.type === "text")),
	);
	if (start < 0) return null;
	const chain = new Set([rows[start].uuid]);
	const texts = [];
	for (const row of rows.slice(start + 1)) {
		if (!row?.uuid || !chain.has(row.parentUuid)) continue;
		chain.add(row.uuid);
		texts.push(...textsOf(row));
	}
	return texts;
}

/** Text written in the same model message as the given tool calls -- what
 * the owner saw just before the tools ran. The tool calls' ids name that
 * message, so nothing about who wrote which row has to be guessed. */
export function textsBeforeTools(rows, toolUseIds) {
	const ids = new Set(toolUseIds);
	const messages = new Set(
		rows
			.filter(
				(r) =>
					r?.type === "assistant" &&
					r.message?.content?.some?.(
						(c) => c?.type === "tool_use" && ids.has(c.id),
					),
			)
			.map((r) => r.message.id),
	);
	return rows.filter((r) => messages.has(r?.message?.id)).flatMap(textsOf);
}

function stop(input, io) {
	const finalText =
		typeof input.last_assistant_message === "string"
			? input.last_assistant_message
			: "";
	const promptId = input.prompt_id;
	if (!promptId) {
		// Nothing ties this reply to a count or to its earlier messages: the
		// final message is checked alone, and sent back once at most.
		if (input.stop_hook_active) return null;
		return decideStop({ finalText, earlierTexts: [], rewrites: 0 });
	}
	const state = io.readState(promptId) ?? {};
	const rewrites = Number(state.rewrites) || 0;
	const sentBack = Array.isArray(state.sentBack)
		? state.sentBack.map(String)
		: [];
	let earlierTexts = [];
	try {
		earlierTexts =
			replyTexts(io.readRows(input.transcript_path), promptId) ?? [];
	} catch {
		// checked on its own
	}
	// Neither the final message itself (it may already be in the file) nor a
	// version already sent back is an earlier message of this reply: counted,
	// a faithful rewrite clashed with the numbers of the version it replaced.
	const notEarlier = [finalText, ...sentBack];
	earlierTexts = earlierTexts.filter((t) => {
		const s = t.trim();
		return s && !notEarlier.some((n) => n.includes(s));
	});
	const answer = decideStop({ finalText, earlierTexts, rewrites });
	if (!answer) return null;
	try {
		io.writeState(promptId, {
			rewrites: rewrites + 1,
			sentBack: [...sentBack, finalText],
		});
	} catch {
		// Without a count, send back once at most.
		if (input.stop_hook_active) return null;
	}
	return answer;
}

/** The whole hook, given its input and the few things it reads and writes.
 * `io.env.REPLY_RULES === "off"` turns it off: for a `claude -p` run whose
 * output no person reads as a reply (the pre-merge /security-review, which
 * has a format of its own), and for a fork that wants none of this. */
export function runHook(input, io) {
	if (!input || typeof input !== "object" || input.agent_id) return null;
	if (String(io.env?.REPLY_RULES ?? "").toLowerCase() === "off") return null;
	switch (input.hook_event_name) {
		case "UserPromptSubmit":
			return decidePrompt();
		case "PostToolBatch": {
			const calls = Array.isArray(input.tool_calls) ? input.tool_calls : [];
			const ids = calls.map((c) => c?.tool_use_id).filter(Boolean);
			if (!ids.length) return null;
			return decideProgress(
				textsBeforeTools(io.readRows(input.transcript_path), ids),
			);
		}
		case "Stop":
			return stop(input, io);
		default:
			return null;
	}
}
