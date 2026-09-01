import type { Env } from "./types";

/**
 * The address account-recovery mail is sent from, or undefined when this
 * deployment has not configured one (which turns the "forgot password" flow
 * off -- see GetSettings).
 *
 * Two sources, and the environment wins. `EmailExplorer({ accountRecovery })`
 * is a value in source code, and source code is the thing a fork inherits
 * from this repository: leaving it in charge would mean every fork sending its
 * password resets as an address it does not own, on a domain whose Resend
 * verification it does not have. The variable is set per deployment, so it is
 * the one that knows.
 *
 * Blank counts as unset. An unset repository variable reaches a workflow step
 * as an empty string, and `from: ""` would fail every recovery send with no
 * obvious cause -- the failure is swallowed on purpose, because reporting it
 * would say which addresses have accounts.
 */
export function recoveryFromEmail(
	env: Pick<Env, "config" | "ACCOUNT_RECOVERY_FROM">,
): string | undefined {
	const fromEnvironment = env.ACCOUNT_RECOVERY_FROM?.trim();
	if (fromEnvironment) return fromEnvironment;

	const fromCode = env.config?.accountRecovery?.fromEmail?.trim();
	return fromCode || undefined;
}

/**
 * The login address that holds the root role, or undefined when this
 * deployment has not named one.
 *
 * Only a repository variable, with no `EmailExplorer({ ... })` option beside
 * it. The recovery sender has both because a fork inherits a sensible default
 * from source; this has no sensible default -- an address checked into a
 * public repository would name, in public, the one account that can create and
 * delete every other. Whoever deploys sets it, and it stays out of the code.
 *
 * Unset means no account is root, and every root-only route refuses everyone.
 * That is the safe direction: the deployment carries on exactly as it did
 * before this existed.
 */
export function rootAdminEmail(
	env: Pick<Env, "ROOT_ADMIN_EMAIL">,
): string | undefined {
	return env.ROOT_ADMIN_EMAIL?.trim() || undefined;
}
