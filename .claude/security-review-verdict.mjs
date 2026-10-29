// What a separate session's security review answered, read from the
// stream-json transcript `claude -p --output-format stream-json` writes.
//
// The point is the case that looks like a pass and is not one. On Claude Code
// 2.1.312 the bare `claude -p "/security-review"` ran no turn at all -- no
// token in, none out, 0.3 s -- and printed nothing with exit status 0, which
// is exactly what a review that found nothing would look like from outside.
// Here a review counts only if the session ran, did not end in an error, and
// said something; anything else is a failure with its reason.
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
	for (const line of transcript.split("\n")) {
		/** @type {any} */
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (event && event.type === "result") result = event;
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
	const review = typeof result.result === "string" ? result.result.trim() : "";
	if (!review) {
		return {
			ok: false,
			reason: "the review session ran but gave no verdict",
		};
	}
	return { ok: true, review };
}
