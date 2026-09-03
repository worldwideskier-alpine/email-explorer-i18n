/**
 * How the second-stage spam check has been going, as the mailbox endpoint
 * reports it.
 *
 * The check fails open: a rejected key, a timeout, anything at all, and the
 * message goes to the inbox. That is the right call -- losing real mail is
 * worse -- but it means a filter that stopped working weeks ago looks exactly
 * like one that is running and finding nothing to catch. The settings screen
 * shows a green "configured" badge either way. These timestamps are what tell
 * the two apart.
 */
export interface SpamCheckHealth {
	lastSuccessAt: string | null;
	/**
	 * Who answered the last check that worked, and from where -- the same
	 * marker a refusal carries. Optional so a dashboard newer than its Worker
	 * still works.
	 */
	lastSuccessVia?: string | null;
	lastFailureAt: string | null;
	lastFailureReason: string | null;
	/**
	 * The one line that says more than the code does: what the classifier
	 * replied when the reply could not be read as a verdict, or -- for a
	 * refusal -- the status and the API's own name for what went wrong
	 * (`403 permission_error`), or that no API error body came back at all.
	 * Never an upstream error body verbatim; the Worker decides what is
	 * showable. Optional so a dashboard newer than its Worker still works.
	 */
	lastFailureDetail?: string | null;
}

/**
 * Whether the check is broken *now*, rather than whether it has ever failed.
 *
 * One bad afternoon last month is not a broken filter, and a warning that
 * stays on screen forever after a single blip is a warning nobody reads. So
 * the question is which is more recent, and a failure with no success behind
 * it at all counts as broken.
 *
 * The timestamps are ISO-8601 UTC, which sorts correctly as text, so no date
 * parsing is needed to compare them.
 */
export function isSpamCheckFailing(
	health: SpamCheckHealth | null | undefined,
): boolean {
	if (!health?.lastFailureAt) return false;
	if (!health.lastSuccessAt) return true;
	return health.lastFailureAt > health.lastSuccessAt;
}

/**
 * The classifier's reply, when there is one worth putting on screen.
 *
 * Tied to whether the check is failing *now* rather than to the field simply
 * being set. The detail belongs to a failure, and a failure that has since
 * been followed by a success is over -- showing what it said would be a
 * warning about something that is no longer happening, which is the exact
 * failing this whole health line exists to correct.
 */
export function spamCheckDetail(
	health: SpamCheckHealth | null | undefined,
): string | null {
	if (!isSpamCheckFailing(health)) return null;
	return health?.lastFailureDetail?.trim() || null;
}

/**
 * Who answered the last check that worked, when the Worker recorded it.
 *
 * Deliberately not tied to `isSpamCheckFailing`, which is the opposite of the
 * rule for the failure detail above. That one describes a failure and stops
 * being true once a success follows it. This one belongs to the success line,
 * which is shown whether or not the check is currently failing -- and it is
 * *most* worth showing while it is failing, because that is when there is a
 * refusal beside it to compare against. Suppressing it then would remove it
 * from the only screen where the comparison can be made.
 */
export function spamCheckSuccessVia(
	health: SpamCheckHealth | null | undefined,
): string | null {
	if (!health?.lastSuccessAt) return null;
	return health.lastSuccessVia?.trim() || null;
}

/**
 * The reason codes the Worker records, and the message for each.
 *
 * The three refusals were once one code, and they are three problems with
 * three different answers: enter the right key; change what the key's
 * workspace may do; or nothing at all on this screen, because the request
 * never reached the API. Telling a reader to check a key that is already
 * correct is worse than saying nothing.
 */
const REASON_KEYS: Record<string, string> = {
	unauthorized: "settings.spamCheckUnauthorized",
	forbidden: "settings.spamCheckForbidden",
	blocked: "settings.spamCheckBlocked",
	rateLimited: "settings.spamCheckRateLimited",
	serverError: "settings.spamCheckServerError",
	timeout: "settings.spamCheckTimeout",
	network: "settings.spamCheckNetwork",
	malformed: "settings.spamCheckMalformed",
};

/**
 * The message key for a recorded reason.
 *
 * A code this version does not know -- a screen running against a newer Worker
 * -- gets a message that says only that the check failed. It used to fall back
 * to "the API returned an error", which was called the vaguest of them and is
 * not vague at all: it is a specific claim, and it was wrong the first time it
 * mattered. A Worker that had just learnt to say "the request never reached
 * the API" was read by a screen that had not, and the screen announced the
 * opposite of what had happened. The reply line beside it still carries the
 * evidence, so nothing is lost by declining to guess.
 */
export function spamCheckReasonKey(reason: string | null | undefined): string {
	return REASON_KEYS[reason ?? ""] ?? "settings.spamCheckUnknown";
}
