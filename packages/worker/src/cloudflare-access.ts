/**
 * The Cloudflare Access signature on a request, checked by the Worker.
 *
 * Access stands in front of every address this deployment answers on, and
 * hands what it lets through a signed token (`Cf-Access-Jwt-Assertion`). The
 * Worker checks it rather than taking Access's word for having been in the
 * way: a route Access does not cover -- a new hostname, a preview address, a
 * policy changed in the dashboard -- would otherwise reach the Worker with
 * nobody having signed in to Access at all.
 *
 * What is checked: the signature (RS256, by a key the issuer publishes at
 * `/cdn-cgi/access/certs`), the issuer, the audience, and that it is in date.
 *
 * Which issuer and audience are this deployment's is learned, not written
 * here: the first token that passes the signature check fixes both in the
 * bucket (`settings/access.json`), and every token after must match them.
 * Written into the source, a team's address would sit in a public repository
 * -- and a fork has another team, or none -- and set by hand it is one more
 * thing to get wrong in a dashboard, with the screen that would mend it
 * behind the mistake. Learning it is safe because Access is in front of every
 * request: the first token to arrive is one Access itself signed for a
 * person it let in. An issuer is only ever a `*.cloudflareaccess.com` team.
 *
 * Until a token has fixed them, a request with no token is let through: that
 * is a deployment without Access -- a fork, the tests, `wrangler dev` -- and
 * the gates behind this one still hold. Once fixed, a request with no token
 * is refused like one with a bad token. Mail and the nightly run are not
 * requests and are not asked.
 */

import type { Env } from "./types";

/** Where the issuer and audience are kept once learned. */
export const ACCESS_KEY = "settings/access.json";

export interface AccessPin {
	issuer: string;
	audience: string;
}

/** The header Access sets on every request it lets through. */
export const ACCESS_HEADER = "Cf-Access-Jwt-Assertion";

/** A team's address, and nothing else, may issue a token here. */
const ISSUER =
	/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/;

/** Clocks disagree a little; Access's tokens last hours. */
const LEEWAY_S = 60;

/** How long a team's published keys are used before they are asked again. */
const KEYS_FOR_MS = 60 * 60 * 1000;

/** A key the token names but the cache does not have is asked again, at most this often. */
const REFRESH_AFTER_MS = 60 * 1000;

export type AccessVerdict =
	| { ok: true; issuer: string; audience: string[] }
	| { ok: false; reason: string; unanswered?: boolean };

interface Jwk {
	kid?: string;
	kty?: string;
	alg?: string;
	n?: string;
	e?: string;
}

/**
 * The team's published keys. Replaceable so that a test can hand over keys
 * of its own: the certs address is a real team's, which the test pool has no
 * way to reach.
 */
export const accessKeys = {
	async load(issuer: string): Promise<Jwk[]> {
		const response = await fetch(`${issuer}/cdn-cgi/access/certs`, {
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok) {
			throw new Error(`the issuer's keys answered ${response.status}`);
		}
		const body = (await response.json()) as { keys?: Jwk[] };
		return Array.isArray(body.keys) ? body.keys : [];
	},
};

const cachedKeys = new Map<string, { keys: Jwk[]; at: number }>();

async function keyFor(
	issuer: string,
	kid: string,
	now: number,
): Promise<Jwk | null | "unanswered"> {
	const cached = cachedKeys.get(issuer);
	const fresh = cached && now - cached.at < KEYS_FOR_MS;
	const hit = cached?.keys.find((key) => key.kid === kid);
	if (hit && fresh) return hit;
	// A key the cache lacks may be a rotation, so ask -- but not on every
	// request that names an unknown key, or a sender could make each of
	// them a fetch.
	if (cached && fresh && now - cached.at < REFRESH_AFTER_MS) return null;
	try {
		const keys = await accessKeys.load(issuer);
		cachedKeys.set(issuer, { keys, at: now });
		return keys.find((key) => key.kid === kid) ?? null;
	} catch {
		// The keys could not be had: stale ones are better than none, and
		// none is a request nobody can answer yet rather than a bad one.
		return hit ?? "unanswered";
	}
}

/** For a test: forget every team's keys. */
export function forgetAccessKeys(): void {
	cachedKeys.clear();
}

function fromBase64Url(text: string): Uint8Array {
	const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
	const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function jsonPart(text: string): Record<string, unknown> | null {
	try {
		const value = JSON.parse(new TextDecoder().decode(fromBase64Url(text)));
		return value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

/**
 * Whether `token` is a token Access signed, in date, from a team's issuer.
 * Says nothing yet about whether it is this deployment's team or
 * application; that is the pin's question (`checkAccess`).
 */
export async function verifyAccessToken(
	token: string,
	now = Date.now(),
): Promise<AccessVerdict> {
	const [head, body, signature, ...rest] = token.split(".");
	if (
		head === undefined ||
		body === undefined ||
		signature === undefined ||
		rest.length > 0 ||
		![head, body, signature].every((part) => /^[\w-]+$/.test(part))
	) {
		return { ok: false, reason: "not a token" };
	}
	const header = jsonPart(head);
	const claims = jsonPart(body);
	if (!header || !claims) return { ok: false, reason: "not a token" };
	// RS256 alone: Access signs with it, and taking the algorithm from the
	// token is how "none" and a public key used as an HMAC secret get in.
	if (header.alg !== "RS256" || typeof header.kid !== "string") {
		return { ok: false, reason: "not signed the way Access signs" };
	}
	const issuer = claims.iss;
	if (typeof issuer !== "string" || !ISSUER.test(issuer)) {
		return { ok: false, reason: "not issued by an Access team" };
	}
	const seconds = now / 1000;
	if (typeof claims.exp !== "number" || claims.exp + LEEWAY_S < seconds) {
		return { ok: false, reason: "out of date" };
	}
	if (typeof claims.nbf === "number" && claims.nbf - LEEWAY_S > seconds) {
		return { ok: false, reason: "not yet in date" };
	}
	const audience = (
		Array.isArray(claims.aud) ? claims.aud : [claims.aud]
	).filter((one): one is string => typeof one === "string" && one !== "");
	if (audience.length === 0) return { ok: false, reason: "for no audience" };

	const jwk = await keyFor(issuer, header.kid, now);
	if (jwk === "unanswered") {
		return {
			ok: false,
			reason: "the issuer's keys could not be had",
			unanswered: true,
		};
	}
	if (!jwk || jwk.kty !== "RSA" || !jwk.n || !jwk.e) {
		return { ok: false, reason: "signed by a key the issuer does not publish" };
	}
	let valid = false;
	try {
		const key = await crypto.subtle.importKey(
			"jwk",
			{ kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
			{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
			false,
			["verify"],
		);
		valid = await crypto.subtle.verify(
			"RSASSA-PKCS1-v1_5",
			key,
			fromBase64Url(signature),
			new TextEncoder().encode(`${head}.${body}`),
		);
	} catch {
		valid = false;
	}
	return valid
		? { ok: true, issuer, audience }
		: { ok: false, reason: "the signature does not verify" };
}

/** The pin, read once per isolate once it exists: it never changes after. */
let pinned: AccessPin | null = null;

/** For a test: forget the pin this isolate has read. */
export function forgetAccessPin(): void {
	pinned = null;
}

async function readPin(env: Env): Promise<AccessPin | null> {
	if (pinned) return pinned;
	const object = await env.BUCKET.get(ACCESS_KEY);
	if (!object) return null;
	const value = (await object.json()) as Partial<AccessPin>;
	if (typeof value.issuer !== "string" || typeof value.audience !== "string") {
		throw new Error(`${ACCESS_KEY} holds no issuer and audience`);
	}
	pinned = { issuer: value.issuer, audience: value.audience };
	return pinned;
}

/**
 * Fixes the issuer and audience of the first token that verified. Only if
 * there is none yet: two first requests at once write the same pair, and the
 * second write is refused rather than put over the first.
 */
async function pin(
	env: Env,
	issuer: string,
	audience: string,
): Promise<AccessPin> {
	const value = { issuer, audience };
	const written = await env.BUCKET.put(ACCESS_KEY, JSON.stringify(value), {
		onlyIf: { uploadedBefore: new Date(0) },
	});
	if (written) {
		pinned = value;
		return value;
	}
	const stored = await readPin(env);
	if (!stored)
		throw new Error(`${ACCESS_KEY} could be neither written nor read`);
	return stored;
}

export type AccessGate =
	| { pass: true }
	| { pass: false; status: 403 | 503; reason: string };

/**
 * Whether a request may go on, by its Access token and the pin.
 *
 * A pin that cannot be read fails closed (503): reading it as "no pin" would
 * let a request with no token through on a deployment that has one.
 */
export async function checkAccess(
	request: Request,
	env: Env,
	now = Date.now(),
): Promise<AccessGate> {
	let pin_: AccessPin | null;
	try {
		pin_ = await readPin(env);
	} catch {
		return {
			pass: false,
			status: 503,
			reason: "the Access settings could not be read",
		};
	}
	const token = request.headers.get(ACCESS_HEADER);
	if (!token) {
		return pin_
			? { pass: false, status: 403, reason: "no Access token" }
			: { pass: true };
	}
	const verdict = await verifyAccessToken(token, now);
	if ("reason" in verdict) {
		return {
			pass: false,
			status: verdict.unanswered ? 503 : 403,
			reason: verdict.reason,
		};
	}
	let fixed = pin_;
	if (!fixed) {
		try {
			fixed = await pin(env, verdict.issuer, verdict.audience[0] ?? "");
		} catch {
			return {
				pass: false,
				status: 503,
				reason: "the Access settings could not be written",
			};
		}
	}
	if (verdict.issuer !== fixed.issuer) {
		return { pass: false, status: 403, reason: "issued by another team" };
	}
	if (!verdict.audience.includes(fixed.audience)) {
		return { pass: false, status: 403, reason: "for another application" };
	}
	return { pass: true };
}
