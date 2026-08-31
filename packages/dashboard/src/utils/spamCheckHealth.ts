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

/** The reason codes the Worker records, and the message for each. */
const REASON_KEYS: Record<string, string> = {
	unauthorized: "settings.spamCheckUnauthorized",
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
