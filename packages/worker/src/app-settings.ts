/**
 * Settings that belong to the deployment rather than to one mailbox.
 *
 * Only the Resend API key lives here so far. It used to be a Worker secret
 * pushed from a GitHub Actions secret on every deploy, which meant rotating
 * it was a trip to GitHub and a redeploy. Now an administrator can set it on
 * the admin screen.
 *
 * What that costs, stated plainly: a Worker secret is write-only -- not
 * readable from the Cloudflare dashboard, not readable by this code's own
 * callers, only by the runtime. An object in R2 is readable by anyone holding
 * the Cloudflare account. So this is weaker against Cloudflare account
 * compromise, and that is a case the rest of this deployment already declares
 * out of scope (see the backup notes: whoever holds the account reaches R2
 * directly, without passing through any of this).
 *
 * Inside the line that is defended -- someone with an administrator's
 * password to this app -- it changes little: such a person can already read
 * every message and send as any mailbox. The key itself is never returned to
 * them, only whether one is set.
 */

import type { Env } from "./types";

/**
 * Where the deployment-wide key used to live. Still read as the last resort,
 * and still what a fresh fork finds if it puts one there, but no longer where
 * anybody's key is written: a single key per deployment is a key shared
 * between customers, and the second customer to save one overwrites the
 * first's -- so the first pays for the second's mail, silently, until the
 * bill arrives.
 */
const KEY = "settings/app.json";

/** One key per person. Whoever sends the mail holds the key that sends it. */
function personKey(personId: string): string {
	return `settings/person/${encodeURIComponent(personId)}.json`;
}

interface AppSettings {
	resendApiKey?: string;
	/**
	 * Whether this person is protected from deletion. Absent means protected;
	 * see isPersonDeletionLocked.
	 */
	deletionLocked?: boolean;
}

/** Where the key in use came from, for the admin screen to show. */
export type ResendKeySource = "stored" | "environment" | "none";

async function readAt(
	env: Pick<Env, "BUCKET">,
	key: string,
): Promise<AppSettings> {
	const obj = await env.BUCKET.get(key);
	if (!obj) return {};
	try {
		return (await obj.json<AppSettings>()) ?? {};
	} catch {
		// A settings object that will not parse must not take outbound mail
		// down with it: an empty result falls back to the environment.
		return {};
	}
}

/**
 * The key that sends a person's mail: their own, or the deployment's if they
 * have not set one.
 *
 * Whose key sends what follows from who the mail is for. A person's outbound
 * mail goes through their key, and so does the mail this application sends on
 * their behalf -- their password reset, their address-change confirmation.
 * Root's key sends root's own; it does not stand behind the customers, which
 * is the point of separating them: the deployment does not pay for mail it
 * knows nothing about.
 *
 * Somebody with no key cannot send. That is a service that has stopped, not a
 * lockout: root sets a password directly, without any mail at all, so the way
 * back in does not depend on being able to send.
 *
 * The environment variable stays as a last resort so a fresh fork works
 * before anybody has set anything. This deployment has none set, so nothing
 * falls through to it.
 */
export async function getResendApiKey(
	env: Pick<Env, "BUCKET"> & { RESEND_API_KEY?: string },
	personId?: string | null,
): Promise<string | undefined> {
	if (personId) {
		const own = (await readAt(env, personKey(personId))).resendApiKey;
		if (own) return own;
	}
	// Left over from when there was one key for the whole deployment. Read so
	// that the deploy introducing per-person keys does not stop mail before
	// anyone has saved theirs.
	const shared = (await readAt(env, KEY)).resendApiKey;
	return shared || env.RESEND_API_KEY || undefined;
}

export async function getResendKeySource(
	env: Pick<Env, "BUCKET"> & { RESEND_API_KEY?: string },
	personId?: string | null,
): Promise<ResendKeySource> {
	if (personId && (await readAt(env, personKey(personId))).resendApiKey) {
		return "stored";
	}
	if ((await readAt(env, KEY)).resendApiKey) return "environment";
	if (env.RESEND_API_KEY) return "environment";
	return "none";
}

/** Stores a person's key, or clears it when given nothing. */
export async function setResendApiKey(
	env: Pick<Env, "BUCKET">,
	personId: string,
	apiKey: string | null,
): Promise<void> {
	const key = personKey(personId);
	const settings = await readAt(env, key);
	const trimmed = apiKey?.trim();
	if (trimmed) settings.resendApiKey = trimmed;
	else delete settings.resendApiKey;
	await env.BUCKET.put(key, JSON.stringify(settings));
}

/** Everything a person's key is stored under, for deleting them. */
export function personSettingsKey(personId: string): string {
	return personKey(personId);
}

/**
 * Whether a person is protected from deletion.
 *
 * The same rule a mailbox has, for the same reason (see isDeletionLocked in
 * mailbox-settings.ts): an absent flag means protected. Every person stored
 * before this existed has no flag, and the alternative reading would leave
 * every one of them deletable in one click on the day this deploys -- which
 * is the state this is here to end.
 *
 * Deleting a person is the largest single act in this application. It takes
 * their logins, their mailboxes, the mail in them, the raw copies, the
 * attachments and every nightly archive, and nothing brings any of it back.
 * A button that does that sits one mis-touch away from the refresh link, on a
 * phone, next to the row for somebody else. So it is two deliberate acts now:
 * turn the lock off, then delete.
 *
 * What this is not: it is not a defence against root, who can unlock anything
 * here. It defends root from their own hand, which is the only thing a lock
 * on this screen could honestly claim to do.
 */
export function isPersonDeletionLocked(
	settings: { deletionLocked?: boolean } | null | undefined,
): boolean {
	return settings?.deletionLocked !== false;
}

/** Whether the stored person is protected. Unreadable settings read locked. */
export async function readPersonDeletionLock(
	env: Pick<Env, "BUCKET">,
	personId: string,
): Promise<boolean> {
	return isPersonDeletionLocked(await readAt(env, personKey(personId)));
}

/**
 * Turns the lock on or off, leaving everything else in the object alone --
 * a person's sending key lives here too, and unlocking must not cost it.
 */
export async function setPersonDeletionLock(
	env: Pick<Env, "BUCKET">,
	personId: string,
	locked: boolean,
): Promise<void> {
	const key = personKey(personId);
	const settings = await readAt(env, key);
	settings.deletionLocked = locked;
	await env.BUCKET.put(key, JSON.stringify(settings));
}
