// The Claude API key used for the (future) second-stage spam classifier is
// a secret, unlike the rest of the mailbox settings blob -- it must never be
// echoed back to the browser once saved, and saving unrelated settings (e.g.
// the signature) must never silently wipe it out. These two helpers keep
// that behavior in one place instead of scattered across the mailbox routes.

type MailboxSettings = Record<string, any>;

/**
 * Strips the raw Claude API key out of a settings object before it's sent
 * to the client, replacing it with a boolean so the UI can still show
 * whether one is configured.
 */
export function redactMailboxSettings(
	settings: MailboxSettings | null | undefined,
): MailboxSettings | null | undefined {
	if (!settings?.spamFilter) return settings;

	const { claudeApiKey, ...rest } = settings.spamFilter;
	return {
		...settings,
		spamFilter: { ...rest, claudeApiKeyConfigured: !!claudeApiKey },
	};
}

/**
 * Merges an incoming (client-submitted) settings object onto the
 * previously stored one for the claudeApiKey field specifically: since the
 * client never sees the real key (see redactMailboxSettings), a save that
 * doesn't explicitly touch `spamFilter.claudeApiKey` must preserve whatever
 * was already stored, rather than wiping it out. The client sets the field
 * explicitly (to a new value, or "" to clear it) only when the user
 * actually edits it.
 */
export function mergeMailboxSettings(
	existing: MailboxSettings | null | undefined,
	incoming: MailboxSettings,
): MailboxSettings {
	const merged = { ...incoming };
	const incomingSpamFilter = incoming?.spamFilter;
	const keyWasTouched =
		!!incomingSpamFilter && Object.hasOwn(incomingSpamFilter, "claudeApiKey");

	const claudeApiKey = keyWasTouched
		? incomingSpamFilter.claudeApiKey || undefined
		: existing?.spamFilter?.claudeApiKey;

	if (incomingSpamFilter || claudeApiKey) {
		merged.spamFilter = { ...incomingSpamFilter, claudeApiKey };
	}

	return merged;
}
