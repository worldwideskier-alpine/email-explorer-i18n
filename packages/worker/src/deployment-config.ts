import type { Env } from "./types";

/** Where root's choice of recovery sender is kept. */
export const RECOVERY_SENDER_KEY = "settings/account-recovery.json";

/**
 * The address account-recovery mail is sent from, or undefined when this
 * deployment has not configured one (which turns the "forgot password" flow
 * off -- see GetSettings).
 *
 * Three sources, in this order:
 *
 * 1. The `ACCOUNT_RECOVERY_FROM` variable, set per deployment in GitHub.
 * 2. What root saved on `/root` (`RECOVERY_SENDER_KEY` in R2). This is the
 *    one meant to be used: everything about running a deployment is done on
 *    the deployed site, and this one used to be a string in `dev/index.ts`
 *    -- which every fork inherited, so a fork that set nothing sent its
 *    resets as an address on somebody else's domain and they never arrived.
 * 3. `EmailExplorer({ accountRecovery })`, for an embedder that sets it in
 *    code. Last, because source code is what a fork inherits.
 *
 * Blank counts as unset. An unset repository variable reaches a workflow step
 * as an empty string, and `from: ""` would fail every recovery send with no
 * obvious cause -- the failure is swallowed on purpose, because reporting it
 * would say which addresses have accounts. A stored value that cannot be read
 * counts as unset too: the flow goes off rather than sending as nothing.
 */
export async function recoveryFromEmail(
	env: Pick<Env, "config" | "ACCOUNT_RECOVERY_FROM" | "BUCKET">,
): Promise<string | undefined> {
	const fromEnvironment = env.ACCOUNT_RECOVERY_FROM?.trim();
	if (fromEnvironment) return fromEnvironment;

	const fromScreen = (await storedRecoverySender(env))?.trim();
	if (fromScreen) return fromScreen;

	const fromCode = env.config?.accountRecovery?.fromEmail?.trim();
	return fromCode || undefined;
}

/** What root saved, or undefined. Never throws. */
export async function storedRecoverySender(
	env: Pick<Env, "BUCKET">,
): Promise<string | undefined> {
	try {
		const object = await env.BUCKET?.get(RECOVERY_SENDER_KEY);
		if (!object) return undefined;
		const stored = await object.json<{ fromEmail?: unknown }>();
		return typeof stored?.fromEmail === "string" ? stored.fromEmail : undefined;
	} catch {
		return undefined;
	}
}
