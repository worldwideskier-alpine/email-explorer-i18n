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

const KEY = "settings/app.json";

interface AppSettings {
	resendApiKey?: string;
}

/** Where the key in use came from, for the admin screen to show. */
export type ResendKeySource = "stored" | "environment" | "none";

async function read(env: Pick<Env, "BUCKET">): Promise<AppSettings> {
	const obj = await env.BUCKET.get(KEY);
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
 * The key to send with: the stored one, or the deployment's own if none has
 * been stored.
 *
 * The environment stays a fallback rather than being removed outright so that
 * the deploy which introduces this screen does not stop mail until somebody
 * visits it. It also leaves a way back if the stored one is wrong.
 */
export async function getResendApiKey(
	env: Pick<Env, "BUCKET"> & { RESEND_API_KEY?: string },
): Promise<string | undefined> {
	const stored = (await read(env)).resendApiKey;
	return stored || env.RESEND_API_KEY || undefined;
}

export async function getResendKeySource(
	env: Pick<Env, "BUCKET"> & { RESEND_API_KEY?: string },
): Promise<ResendKeySource> {
	if ((await read(env)).resendApiKey) return "stored";
	if (env.RESEND_API_KEY) return "environment";
	return "none";
}

/**
 * Stores a key, or clears the stored one when given nothing.
 *
 * Clearing does not disable sending; it falls back to the deployment's own
 * key if there still is one. That is the honest behaviour to expose, and the
 * admin screen says which of the two is in use.
 */
export async function setResendApiKey(
	env: Pick<Env, "BUCKET">,
	apiKey: string | null,
): Promise<void> {
	const settings = await read(env);
	const trimmed = apiKey?.trim();
	if (trimmed) settings.resendApiKey = trimmed;
	else delete settings.resendApiKey;
	await env.BUCKET.put(KEY, JSON.stringify(settings));
}
