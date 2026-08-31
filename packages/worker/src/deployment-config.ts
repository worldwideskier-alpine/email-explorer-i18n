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
