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
	/**
	 * What a successful attempt does to this key (see throttleSettle):
	 * "reset" forgets its failures, "refund" hands back only that attempt,
	 * and absent leaves the attempt counted.
	 */
	onSuccess?: "reset" | "refund";
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
	const ip = request.headers.get("CF-Connecting-IP");
	return ip ? throttleAddress(ip) : "unknown";
}

/**
 * The part of an address that one client actually holds.
 *
 * An IPv6 subscriber is handed a whole /64 and picks any of its 2^64
 * addresses at will, so counting the full address let one client move to a
 * fresh counter on every attempt and the per-IP rule caught nothing. The /64
 * is what a single subscriber cannot step out of. IPv4 is counted as it is.
 */
export function throttleAddress(ip: string): string {
	if (!ip.includes(":")) return ip;
	// IPv4 written as IPv6 ("::ffff:192.0.2.1") is one IPv4 client; by its
	// /64 every such client would share one counter.
	if (ip.includes(".")) return ip.slice(ip.lastIndexOf(":") + 1);
	const [head, tail] = ip.toLowerCase().split("::", 2);
	const left = head ? head.split(":") : [];
	const right = tail ? tail.split(":") : [];
	const groups =
		tail === undefined
			? left
			: [
					...left,
					...Array(Math.max(0, 8 - left.length - right.length)).fill("0"),
					...right,
				];
	const prefix = groups
		.slice(0, 4)
		.map((g) => Number.parseInt(g || "0", 16).toString(16));
	return `${prefix.join(":")}::/64`;
}

/**
 * Two rules per attempt, deliberately.
 *
 * The per-account rule is what stops one account being ground down, whether
 * the guesses come from one address or ten thousand. The per-IP rule is
 * looser but catches the other shape of attack: a few guesses each against
 * many accounts, which never trips any single account's counter.
 *
 * The per-account rule also let anyone who knew an address lock its owner
 * out: ten wrong passwords from anywhere, and the right one was refused for
 * fifteen minutes, again and again for as long as somebody kept sending them
 * -- root's address included, on a deployment where nothing else stands in
 * front of the form until root sets Turnstile. "The owner can simply wait"
 * was the claim, and it held for no one under a patient stranger. So a
 * browser this login trusts (login-device.ts) is counted on a key of its
 * own, with the same limit: a stranger's failures lock out strangers, and
 * the owner's browser locks only itself. Everything without that cookie --
 * every network, every new browser -- still shares the address's key, so
 * guessing from many places is held to the same ten.
 */
export function loginThrottleRules(
	email: string,
	ip: string,
	trustedBrowser?: { tokenHash: string; userId: string },
): ThrottleRule[] {
	return [
		{
			key: trustedBrowser
				? `login:device:${trustedBrowser.tokenHash}:${trustedBrowser.userId}`
				: `login:user:${email.trim().toLowerCase()}`,
			limit: 10,
			windowMs: 15 * MINUTE,
			lockMs: 15 * MINUTE,
			onSuccess: "reset",
		},
		{
			key: `login:ip:${ip}`,
			limit: 30,
			windowMs: 15 * MINUTE,
			lockMs: 15 * MINUTE,
			onSuccess: "refund",
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
 * stolen session -- the routes that ask for it all sit behind a session, so
 * this is the fallback if one leaks. And using a logged-in account to send
 * confirmation mail at whatever address the caller names.
 *
 * They are two sets of keys, because they end differently. A right password
 * clears the guessing count, the way a login does; a sent confirmation is the
 * very thing being limited, so it stays counted. They used to share keys, and
 * `sendsMail` only decided whether this route cleared them -- so any other
 * route that asked for the password and got it right (changing it, adding a
 * sign-in address, setting a sending key) cleared the mail count too, and the
 * limit on confirmation mail was as many as anybody liked.
 */
export function accountChangeThrottleRules(
	userId: string,
	ip: string,
	{ sendsMail }: { sendsMail: boolean },
): ThrottleRule[] {
	const guessing: ThrottleRule[] = [
		{
			key: `account:user:${userId}`,
			limit: 10,
			windowMs: HOUR,
			lockMs: HOUR,
			onSuccess: "reset",
		},
		{
			key: `account:ip:${ip}`,
			limit: 20,
			windowMs: HOUR,
			lockMs: HOUR,
			onSuccess: "refund",
		},
	];
	if (!sendsMail) return guessing;
	return [
		...guessing,
		{
			key: `account-mail:user:${userId}`,
			limit: 10,
			windowMs: HOUR,
			lockMs: HOUR,
		},
		{
			key: `account-mail:ip:${ip}`,
			limit: 20,
			windowMs: HOUR,
			lockMs: HOUR,
		},
	];
}

/**
 * Registration is reached without a session and costs a password hash when it
 * goes ahead, so each address gets a few an hour, refused ones included. One
 * rule, by address: there is no account yet to count against, and a form
 * closed after root is refused before any hashing (registerFromForm).
 */
export function registerThrottleRules(ip: string): ThrottleRule[] {
	return [
		{
			key: `register:ip:${ip}`,
			limit: 10,
			windowMs: HOUR,
			lockMs: HOUR,
		},
	];
}

/** Retry-After is defined in whole seconds, and never below 1. */
export function retryAfterSeconds(retryAfterMs: number): number {
	return Math.max(1, Math.ceil(retryAfterMs / 1000));
}
