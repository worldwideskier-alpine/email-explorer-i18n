/**
 * Rate limiting for the two unauthenticated endpoints that are worth
 * attacking: login (password guessing) and password reset (account
 * enumeration, and using someone else's mailbox as a mail bomb).
 *
 * Counters live in the auth Durable Object rather than in memory, because a
 * Worker isolate is per-colo and short-lived -- an in-memory counter would
 * reset constantly and reset differently in every location, which is no
 * limit at all. The auth DO is a single instance globally, so it sees every
 * attempt.
 */

export interface ThrottleRule {
	key: string;
	/** Attempts allowed inside the window before the key locks. */
	limit: number;
	windowMs: number;
	/** How long the key stays locked once the limit is crossed. */
	lockMs: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * Cloudflare sets this on every request that reaches a Worker and it cannot
 * be spoofed by the client (an inbound CF-Connecting-IP header is
 * overwritten). Falls back to a shared bucket rather than to no limit at
 * all, so a request arriving without it -- `wrangler dev`, a test -- is
 * still counted.
 */
export function clientIp(request: Request): string {
	return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

/**
 * Two rules per attempt, deliberately.
 *
 * The per-account rule is what stops one account being ground down, whether
 * the guesses come from one address or ten thousand. The per-IP rule is
 * looser but catches the other shape of attack: a few guesses each against
 * many accounts, which never trips any single account's counter.
 *
 * The per-account rule does mean someone can lock a known address out for
 * the lock window on purpose. That is the standard trade for having any
 * account-level limit at all; the window is kept short so the damage is
 * bounded, and a legitimate user who knows their password can simply wait.
 */
export function loginThrottleRules(email: string, ip: string): ThrottleRule[] {
	return [
		{
			key: `login:user:${email.trim().toLowerCase()}`,
			limit: 10,
			windowMs: 15 * MINUTE,
			lockMs: 15 * MINUTE,
		},
		{
			key: `login:ip:${ip}`,
			limit: 30,
			windowMs: 15 * MINUTE,
			lockMs: 15 * MINUTE,
		},
	];
}

/**
 * Counted on every request, not just failed ones: a reset request always has
 * an effect (it sends mail to a real address), so "success" is exactly the
 * case worth limiting.
 */
export function passwordResetThrottleRules(
	email: string,
	ip: string,
): ThrottleRule[] {
	return [
		{
			key: `reset:user:${email.trim().toLowerCase()}`,
			limit: 3,
			windowMs: HOUR,
			lockMs: HOUR,
		},
		{
			key: `reset:ip:${ip}`,
			limit: 10,
			windowMs: HOUR,
			lockMs: HOUR,
		},
	];
}

/**
 * Two things are being limited here. Guessing the current password from a
 * stolen session -- the change-password and change-email routes both ask for
 * it, and both sit behind a session, so this is the fallback if one leaks.
 * And using a logged-in account to send confirmation mail at whatever address
 * the caller names.
 */
export function accountChangeThrottleRules(
	userId: string,
	ip: string,
): ThrottleRule[] {
	return [
		{
			key: `account:user:${userId}`,
			limit: 10,
			windowMs: HOUR,
			lockMs: HOUR,
		},
		{
			key: `account:ip:${ip}`,
			limit: 20,
			windowMs: HOUR,
			lockMs: HOUR,
		},
	];
}

export function throttleKeys(rules: ThrottleRule[]): string[] {
	return rules.map((rule) => rule.key);
}

/** Retry-After is defined in whole seconds, and never below 1. */
export function retryAfterSeconds(retryAfterMs: number): number {
	return Math.max(1, Math.ceil(retryAfterMs / 1000));
}
