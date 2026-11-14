// What a separate session's security review answered, read from the
// stream-json transcript `claude -p --output-format stream-json` writes.
//
// The point is the case that looks like a pass and is not one. On Claude Code
// 2.1.312 the bare `claude -p "/security-review"` ran no turn at all -- no
// token in, none out, 0.3 s -- and printed nothing with exit status 0, which
// is exactly what a review that found nothing would look like from outside.
// Here a review counts only if the session ran, did not end in an error, ran
// the security-review skill, and said something; anything else is a failure
// with its reason.
//
// The skill has to be seen to run because on 2.1.325 `claude -p` began asking
// permission for it, nobody was there to give it, and the session read the
// diff by hand instead and answered "no findings" -- a verdict, so it passed,
// and nothing said the skill had not run. The script now allows the skill
// (security-review.sh); this is what notices when that stops being enough.
// Read from the shape of the transcript, a Skill call and its result, never
// from the words Claude Code puts in that result.
//
// Pure, so the worker suite tests it (security-review-verdict.test.ts);
// security-review-run.mjs moves the bytes.

/**
 * @typedef {{ ok: true, review: string } | { ok: false, reason: string }} Verdict
 */

/**
 * @param {string} transcript the stream-json lines, as written
 * @returns {Verdict}
 */
export function reviewVerdict(transcript) {
	/** @type {any} */
	let result = null;
	/** @type {any[]} */
	const events = [];
	for (const line of transcript.split("\n")) {
		/** @type {any} */
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (!event || typeof event !== "object") continue;
		events.push(event);
		if (event.type === "result") result = event;
	}
	if (!result) {
		return { ok: false, reason: "the review session ended without a result" };
	}
	if (result.is_error || result.subtype !== "success") {
		return {
			ok: false,
			reason: `the review session ended in an error (${String(result.subtype)})`,
		};
	}
	if (!(Number(result.num_turns) > 0)) {
		return {
			ok: false,
			reason:
				"the review session ran no turn, so nothing was reviewed (the bare /security-review form does this)",
		};
	}
	const skill = skillRun(events);
	if (skill !== "ran") return { ok: false, reason: skill };
	const review = typeof result.result === "string" ? result.result.trim() : "";
	if (!review) {
		return {
			ok: false,
			reason: "the review session ran but gave no verdict",
		};
	}
	return { ok: true, review };
}

/** The skill the review has to have run. */
const SKILL = "security-review";

/**
 * "ran" when the session called the security-review skill and the call was
 * answered without an error; otherwise why it does not count.
 *
 * @param {any[]} events
 * @returns {string}
 */
function skillRun(events) {
	/** @type {Set<string>} */
	const calls = new Set();
	/** @type {string | null} */
	let refused = null;
	for (const event of events) {
		for (const block of contentOf(event)) {
			if (
				event.type === "assistant" &&
				block?.type === "tool_use" &&
				block.name === "Skill" &&
				block.input?.skill === SKILL &&
				typeof block.id === "string"
			) {
				calls.add(block.id);
			}
			if (
				event.type === "user" &&
				block?.type === "tool_result" &&
				calls.has(block.tool_use_id)
			) {
				if (block.is_error !== true) return "ran";
				refused ??= firstLine(block.content);
			}
		}
	}
	if (refused !== null) {
		return `the review session was refused the ${SKILL} skill (${refused}), so whatever it answered was not that review`;
	}
	if (calls.size > 0) {
		return `the review session asked for the ${SKILL} skill and was never answered`;
	}
	return `the review session never ran the ${SKILL} skill, so whatever it answered was not that review`;
}

/** @param {any} event */
function contentOf(event) {
	const content = event?.message?.content;
	return Array.isArray(content) ? content : [];
}

/**
 * What a tool result said, on one line and short: it goes into the reason.
 * @param {unknown} content
 */
function firstLine(content) {
	const text =
		typeof content === "string"
			? content
			: Array.isArray(content)
				? content
						.map((part) => (typeof part?.text === "string" ? part.text : ""))
						.join(" ")
				: "";
	const line = text.split("\n").find((l) => l.trim() !== "") ?? "";
	const short = line.trim().slice(0, 200);
	return short === "" ? "no reason given" : short;
}
