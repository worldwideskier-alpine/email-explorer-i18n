/**
 * The subject of a reply or a forward.
 *
 * A prefix was added unless the subject began with exactly `Re: ` or `Fwd: `,
 * so a German reply (`AW:`) came back as `Re: AW: ...`, and so did `RE:` from
 * Outlook in English, and every round of a thread added one more. A subject
 * that already says it is a reply -- in any of the spellings mail clients
 * write, in any case, numbered or not, with a full-width colon or not -- is
 * kept as it is.
 */

// Written by clients in the languages this dashboard offers, or commonly
// seen from them. Only the prefix itself: what follows is the sender's.
// Outlook's one-letter Italian `R:` and `I:` are left out: a subject that
// happens to begin "I: ..." is more likely than either.
const REPLY = [
	"re",
	"aw", // German
	"sv", // Swedish, Danish, Norwegian
	"vs", // Finnish
	"antw", // Dutch
	"odp", // Polish
	"rif", // Italian
	"res", // Portuguese
	"ynt", // Turkish
	"atb", // Latvian
	"vá", // Hungarian
	"回复",
	"回覆",
	"答复",
	"答覆",
	"返信",
	"답장",
];
const FORWARD = [
	"fwd",
	"fw",
	"wg", // German
	"vs", // Finnish uses VS for both, but also VL
	"vl", // Finnish
	"tr", // French
	"rv", // Spanish
	"doorst", // Dutch
	"pd", // Polish
	"enc", // Portuguese
	"inoltro", // Italian
	"İlt", // Turkish
	"转发",
	"轉寄",
	"轉發",
	"転送",
	"전달",
];

// The counter carries its own trailing space. Written as `\s*(counter)?\s*`,
// two runs of white space sat side by side with nothing between them when
// there was no counter, and a subject of "Re" and a long run of spaces was
// split between them every possible way before failing: quadratic, from a
// sender's subject, on reply or forward (Claude Security F13). The subjects
// it accepts are the same.
const prefixPattern = (words: string[]) =>
	new RegExp(
		`^\\s*(?:${words
			.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
			.join("|")})\\s*(?:(?:\\[\\d+\\]|\\^\\d+)\\s*)?[:：]`,
		"iu",
	);

const IS_REPLY = prefixPattern(REPLY);
const IS_FORWARD = prefixPattern(FORWARD);

export function replySubject(subject: string): string {
	return IS_REPLY.test(subject) ? subject : `Re: ${subject}`;
}

export function forwardSubject(subject: string): string {
	return IS_FORWARD.test(subject) ? subject : `Fwd: ${subject}`;
}
