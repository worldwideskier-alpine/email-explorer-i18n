// The Claude API key used for the second-stage spam classifier is a secret,
// unlike the rest of the mailbox settings blob -- it must never be echoed
// back to the browser once saved, and saving unrelated settings (e.g. the
// signature) must never silently wipe it out. These helpers keep that
// behavior in one place instead of scattered across the mailbox routes.

import type { Env } from "./types";

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

/**
 * Reads the raw Claude API key for a mailbox straight from R2 (not through
 * GetMailbox, which redacts it). Used only server-side, by the second-stage
 * spam classifier at ingest time.
 */
export async function getClaudeApiKey(
	env: Pick<Env, "BUCKET">,
	mailboxId: string,
): Promise<string | undefined> {
	const obj = await env.BUCKET.get(`mailboxes/${mailboxId}.json`);
	if (!obj) return undefined;
	const settings = await obj.json<MailboxSettings>();
	return settings?.spamFilter?.claudeApiKey || undefined;
}

export type SenderVerdict = "spam" | "inbox";

/**
 * Per-mailbox sender allow/block list, built from the user explicitly
 * marking an email as spam or not-spam. Deterministic and free (no API
 * call): once a sender has been corrected once, every future message from
 * that exact address is routed straight to the corrected folder, skipping
 * the SPF/DKIM/DMARC check and the Claude second-stage classifier entirely.
 */
function normalizeAddress(address: string): string {
	return address.trim().toLowerCase();
}

/**
 * Looks up whether the given sender address has an explicit user-set
 * verdict for this mailbox. Returns undefined when there's no override,
 * meaning the normal classification pipeline should run as usual.
 */
export async function getSenderVerdictOverride(
	env: Pick<Env, "BUCKET">,
	mailboxId: string,
	fromAddress: string | undefined,
): Promise<SenderVerdict | undefined> {
	if (!fromAddress) return undefined;

	const obj = await env.BUCKET.get(`mailboxes/${mailboxId}.json`);
	if (!obj) return undefined;
	const settings = await obj.json<MailboxSettings>();
	const rules = settings?.senderRules;
	if (!rules) return undefined;

	const normalized = normalizeAddress(fromAddress);
	if ((rules.block || []).includes(normalized)) return "spam";
	if ((rules.allow || []).includes(normalized)) return "inbox";
	return undefined;
}

/**
 * Records the user's explicit spam/not-spam correction for a sender
 * address: adds it to the matching list and removes it from the opposite
 * one, so a corrected sender can never be in both. Read-modify-write on the
 * mailbox's settings object in R2.
 */
export async function recordSenderVerdict(
	env: Pick<Env, "BUCKET">,
	mailboxId: string,
	fromAddress: string,
	verdict: SenderVerdict,
): Promise<MailboxSettings> {
	const key = `mailboxes/${mailboxId}.json`;
	const obj = await env.BUCKET.get(key);
	const settings: MailboxSettings = obj ? await obj.json() : {};

	const normalized = normalizeAddress(fromAddress);
	const existingAllow: string[] = settings.senderRules?.allow || [];
	const existingBlock: string[] = settings.senderRules?.block || [];

	const allow = existingAllow.filter((a) => a !== normalized);
	const block = existingBlock.filter((a) => a !== normalized);
	(verdict === "inbox" ? allow : block).push(normalized);

	const updated = { ...settings, senderRules: { allow, block } };
	await env.BUCKET.put(key, JSON.stringify(updated));
	return updated;
}
