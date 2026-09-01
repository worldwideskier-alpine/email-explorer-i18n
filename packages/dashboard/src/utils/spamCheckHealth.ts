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
 * The reason codes the Worker records, and the message for each.
 *
 * `unauthorized` and `forbidden` were one code, and they are not one problem:
 * the first is answered by entering the right key, the second is not answered
 * by entering any key at all. Telling a reader to check their key when the key
 * is already correct is worse than saying nothing.
 */
const REASON_KEYS: Record<string, string> = {
	unauthorized: "settings.spamCheckUnauthorized",
	forbidden: "settings.spamCheckForbidden",
	rateLimited: "settings.spamCheckRateLimited",
	serverError: "settings.spamCheckServerError",
	timeout: "settings.spamCheckTimeout",
	network: "settings.spamCheckNetwork",
	malformed: "settings.spamCheckMalformed",
};

/**
 * The message key for a recorded reason. A code this version does not know --
 * a deployment running an older dashboard against a newer Worker -- falls back
 * to the vaguest of them rather than showing the raw code or nothing at all.
 */
export function spamCheckReasonKey(reason: string | null | undefined): string {
	return REASON_KEYS[reason ?? ""] ?? "settings.spamCheckServerError";
}
