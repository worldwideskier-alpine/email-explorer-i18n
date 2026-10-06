/**
 * A browser that has signed in to a login before, told apart from every
 * other client (OWASP's "device cookies").
 *
 * The per-address sign-in limit is what stops a password being ground down
 * from many networks at once, and it is also a way to lock anyone out whose
 * address is known: ten wrong passwords from anywhere, every fifteen
 * minutes, and the owner's right one was refused as well -- root's
 * included, and Turnstile is off until root turns it on. A browser that has
 * proved the password before is not one of the many networks, so its
 * attempts are counted on a key of its own, and a stranger's failures lock
 * out strangers.
 *
 * The browser is handed a random token in a cookie; the auth object keeps
 * only its digest, bound to the login and to the password and address the
 * login had when it was handed out (see `loginTake` in the Durable Object).
 * A new token is handed out at every sign-in and the one presented is
 * retired, so a copy taken from the browser stops working the next time its
 * owner signs in.
 */

export const DEVICE_COOKIE = "login_device";

/**
 * Sent with the sign-in request alone. The cookie signs nothing in anywhere,
 * and only the sign-in route reads it; a narrower path keeps it out of every
 * other request, including the ones a message in the reading frame makes.
 */
export const DEVICE_PATH = "/api/v1/auth/login";

/** How long a browser's standing lasts after its last successful sign-in. */
export const DEVICE_TTL_MS = 180 * 24 * 60 * 60 * 1000;

/**
 * Failures on one trusted browser, between its successes, before its
 * standing goes: OWASP's N*10, with N the per-address limit. Without one, a
 * copy of the cookie would be ten guesses every fifteen minutes, past the
 * address's lock, for as long as the owner did not sign in again.
 */
export const DEVICE_FAILURE_CAP = 100;

/** How many presented `login_device` values are looked at. */
export const MAX_PRESENTED_DEVICES = 5;

/** 32 random bytes in base64url, as newDeviceToken writes them. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Every well-shaped `login_device` value the request carries, up to five,
 * not only the first: a sibling subdomain can set one with a Domain
 * attribute, and the browser may send it ahead of ours. Read by whole name,
 * as the session cookie is.
 */
export function deviceTokensOf(request: Request): string[] {
	const out: string[] = [];
	for (const pair of (request.headers.get("Cookie") ?? "").split(";")) {
		const at = pair.indexOf("=");
		if (at <= 0 || pair.slice(0, at).trim() !== DEVICE_COOKIE) continue;
		const value = pair.slice(at + 1).trim();
		if (TOKEN_SHAPE.test(value) && !out.includes(value)) out.push(value);
		if (out.length >= MAX_PRESENTED_DEVICES) break;
	}
	return out;
}

export function newDeviceToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

/** What the auth object keeps of a token: never the token itself. */
export async function deviceHash(token: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(token),
	);
	return [...new Uint8Array(digest)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export function deviceCookie(token: string): string {
	return `${DEVICE_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=${DEVICE_PATH}; Max-Age=${DEVICE_TTL_MS / 1000}`;
}

/**
 * What a sign-in hands the auth object about the browser it came from: the
 * digest of the token `loginTake` found trusted, if any, and the digest of
 * the new token the browser leaves with if the password is right.
 */
export interface DeviceStanding {
	trusted: string | null;
	grant: string;
}
