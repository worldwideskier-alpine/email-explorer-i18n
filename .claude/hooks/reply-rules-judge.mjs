// What CLAUDE.md asks of the text the owner reads, written as checks a
// program makes on every reply -- because a rule the model only reads was
// broken in the same session that wrote it down: progress lines and final
// reports came out in English, and items came out as unnumbered bullets or
// with a number used twice, so the owner could not point at one.
//
// Pure functions only, no node: imports, so the worker suite can import this
// file as it imports scripts/night-check.mjs. reply-rules.mjs is the hook
// that reads stdin, the transcript and its state file, and calls these.

// Hiragana, katakana (full and half width) and CJK ideographs. Japanese prose
// always has some; English prose has none.
const JAPANESE = /[぀-ヿㇰ-ㇿ㐀-䶿一-鿿ｦ-ﾟ]/;
// Two letters or more, so "a", "F3" or "v2" do not count as English words.
const LATIN_WORD = /[A-Za-z][A-Za-z'’-]*[A-Za-z]/g;
// A line this long with no Japanese at all is an English sentence, not an
// identifier or a heading such as "Current Version ID".
const ENGLISH_LINE_WORDS = 5;
// A whole message with no Japanese and this many words is English, however
// short: "Merging now." is the kind of line that slipped through.
const ENGLISH_MESSAGE_WORDS = 2;

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const BULLET_DOT = /^\s*[・•‣◦●▪]/;
// Only at the margin: an indented "- " under a numbered item is a note on
// that item, and the item's number still names it.
const BULLET_TOP = /^[-*+][ \t]+\S/;
const RULE_LINE = /^([-*_])([ \t]*\1){2,}[ \t]*$/;
const ORDERED_ITEM = /^\s*(\d{1,3})[.)][ \t]+\S/;
const BOLD_NUMBER = /^\s*\*\*(\d{1,3})[.)．]/;
const NUMBERED_HEADING = /^\s{0,3}#{1,6}[ \t]+[（(]?(\d{1,3})[.)）．、]/;

/** The lines a reader sees as prose: outside code fences, with inline code,
 * URLs, link targets and HTML tags taken out, since those are English by
 * nature and say nothing about the language of the reply. */
export function proseLines(text) {
	const out = [];
	let fence = null;
	for (const raw of String(text ?? "").split(/\r?\n/)) {
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
			.replace(/\]\([^)]*\)/g, "]")
			.replace(/<https?:[^>]*>/g, " ")
			.replace(/https?:\/\/\S+/g, " ")
			.replace(/<\/?[A-Za-z][^>]*>/g, " ");
		out.push({ raw, prose });
	}
	return out;
}

function words(s) {
	return s.match(LATIN_WORD)?.length ?? 0;
}

function excerpt(s) {
	const t = s.trim();
	return t.length > 60 ? `${t.slice(0, 57)}...` : t;
}

/** Problems with the language of one message the owner will read. */
export function languageProblems(text) {
	const lines = proseLines(text);
	const all = lines.map((l) => l.prose).join("\n");
	if (!JAPANESE.test(all) && words(all) >= ENGLISH_MESSAGE_WORDS) {
		return [
			`日本語が一文字もありません（「${excerpt(lines.find((l) => words(l.prose) > 0)?.raw ?? all)}」）。`,
		];
	}
	return lines
		.filter(
			(l) => !JAPANESE.test(l.prose) && words(l.prose) >= ENGLISH_LINE_WORDS,
		)
		.map((l) => `英語の行があります（「${excerpt(l.raw)}」）。`);
}

/** Problems with how the items of one message are marked. */
export function bulletProblems(text) {
	const problems = [];
	for (const { raw } of proseLines(text)) {
		if (BULLET_DOT.test(raw)) {
			problems.push(`中黒で項目を立てています（「${excerpt(raw)}」）。`);
		} else if (BULLET_TOP.test(raw) && !RULE_LINE.test(raw)) {
			problems.push(`番号のない項目があります（「${excerpt(raw)}」）。`);
		}
		const heading = raw.match(NUMBERED_HEADING);
		if (heading) {
			problems.push(`見出しに番号が付いています（「${excerpt(raw)}」）。`);
		}
	}
	return problems;
}

/** Every item number a message shows: list items at any depth, bold
 * numbers that stand in for a heading, and numbered headings. */
export function itemNumbers(text) {
	const numbers = [];
	for (const { raw } of proseLines(text)) {
		const m =
			raw.match(ORDERED_ITEM) ??
			raw.match(BOLD_NUMBER) ??
			raw.match(NUMBERED_HEADING);
		if (m) numbers.push(Number(m[1]));
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

export const REMINDER = [
	"返答の約束（CLAUDE.md）:",
	"利用者への返答と途中の報告は日本語で書く。",
	"項目は通し番号で書き、中黒や行頭の「-」で項目を立てない（番号付きの項目の下に字下げした補足は可）。",
	"一つの返答の中で同じ番号を二度使わず、見出しには番号を付けない。",
	"利用者の判断が要るときは、精査した推奨案を一つ示す。",
].join("\n");

const REWRITE = [
	"この返答は、CLAUDE.md の返答の約束に反しています。",
	"同じ内容を、約束どおりに書き直して、もう一度出してください（日本語、通し番号、一つの返答で番号を重ねない、見出しに番号を付けない、中黒や行頭の「-」で項目を立てない）。",
	"書き直しには、謝罪や経緯の説明を足さないでください。この知らせのことも書かないでください。",
].join("\n");

// Both say not to apologise or explain: measured, a warning without that
// line came back as a paragraph of apology in the next reply, which is one
// more line the owner did not ask for.
const WARN = [
	"直前の途中報告が、CLAUDE.md の返答の約束に反していました。",
	"表示済みの行は取り消せません。次の報告から、約束どおりに書いてください。",
	"この知らせのことを返答に書いたり、謝ったりはしないでください。",
].join("\n");

/** How many times one reply may be sent back for rewriting. The runtime has
 * its own cap of eight, but a rule this file gets wrong would then cost
 * eight rewrites; two is enough for a real slip. */
export const MAX_REWRITES = 2;

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
			additionalContext: `${REWRITE}\n\n${problems.map((p, i) => `${i + 1}. ${p}`).join("\n")}`,
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
			additionalContext: `${WARN}\n\n${problems.map((p, i) => `${i + 1}. ${p}`).join("\n")}`,
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

/** Transcript rows of one reply: from the prompt that started it to the
 * end. `rows` are parsed JSONL rows, possibly only the file's tail. */
export function replyTexts(rows, promptId) {
	const start = rows.findIndex(
		(r) =>
			r?.type === "user" &&
			r.promptId === promptId &&
			(typeof r.message?.content === "string" ||
				r.message?.content?.some?.((c) => c?.type === "text")),
	);
	if (start < 0) return null;
	return assistantTexts(rows.slice(start + 1));
}

/** Text written in the same model message as the given tool calls -- what
 * the owner saw just before the tools ran. */
export function textsBeforeTools(rows, toolUseIds) {
	const ids = new Set(toolUseIds);
	const messages = new Set(
		mainAgentRows(rows)
			.filter((r) =>
				r.message.content.some((c) => c?.type === "tool_use" && ids.has(c.id)),
			)
			.map((r) => r.message.id),
	);
	return assistantTexts(rows.filter((r) => messages.has(r?.message?.id)));
}

// The main agent's own messages. The transcript also holds what other models
// wrote inside the session -- a plugin's review run as a skill
// (attributionSkill), a hook's yes-or-no, an error the runtime wrote
// (<synthetic>) -- none of which the owner reads as the reply.
function mainAgentRows(rows) {
	const own = rows.filter(
		(r) =>
			r?.type === "assistant" &&
			!r.isSidechain &&
			!r.attributionSkill &&
			!r.isApiErrorMessage &&
			r.message?.model !== "<synthetic>" &&
			Array.isArray(r.message?.content),
	);
	// Side queries can also run on another model with nothing else to tell
	// them apart, so keep the model that wrote most of these rows.
	const counts = new Map();
	for (const r of own)
		counts.set(r.message.model, (counts.get(r.message.model) ?? 0) + 1);
	const main = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
	return own.filter((r) => r.message.model === main);
}

function assistantTexts(rows) {
	return mainAgentRows(rows).flatMap((r) =>
		r.message.content.filter((c) => c?.type === "text").map((c) => c.text),
	);
}
