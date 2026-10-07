/**
 * The Cloudflare Access signature on a request, checked by the Worker.
 *
 * Access stands in front of the addresses this deployment answers on, and
 * hands what it lets through a signed token (`Cf-Access-Jwt-Assertion`). The
 * Worker checks it rather than taking Access's word for having been in the
 * way: a route Access does not cover -- a new hostname, a policy changed in
 * the dashboard -- would otherwise reach the Worker with nobody having signed
 * in to Access at all.
 *
 * What is checked: the issuer, the signature (RS256, by a key that issuer
 * publishes at `/cdn-cgi/access/certs`), that it is in date, and the audience.
 *
 * Which team and application are this deployment's are written by the
 * deploy, never learned from a request. The deploy asks every address it
 * deployed to for its page and for an API path, without following a
 * redirect; behind Access the answer is a redirect to the team's sign-in,
 * whose host is the team and whose `kid` names the application by its
 * audience tag.
 * The deploy writes them to `settings/access.json` with the R2 access it
 * already has, and deletes the file only when every answer came without
 * Access (deployment-check.mjs, `accessDoorOf`). Nothing has to be set in a
 * dashboard, and a fork's team, or none, is found the same way.
 *
 * Learning the team from the first token instead was the first version of
 * this, and it let anybody with a team of their own -- anyone can make one --
 * fix theirs on a deployment that had no Access, or on an address Access did
 * not cover, and lock its owner out. A token's issuer is compared with the
 * written one before any key is fetched, so a stranger's team costs no
 * request either.
 *
 * A redirect with no `kid` of that shape leaves the applications unwritten,
 * and then the first token that verifies under the written team fixes one,
 * as the instruction for this allowed. That is the fallback, not the rule:
 * on an address Access does not cover, a token from another application of
 * the same team could be the first.
 *
 * With no file a request is let through, token or not: that is a deployment
 * without Access -- a fork, the tests, `wrangler dev` -- and the gates behind
 * this one still hold. Mail and the nightly run are not requests and are not
 * asked.
 */

import type { Env } from "./types";

/** Where the deploy writes the team and the application. */
export const ACCESS_KEY = "settings/access.json";

export interface AccessSettings {
	issuer: string;
	/** Any one of them will do: each address may be an application of its own. */
	audiences?: string[];
}

/** The header Access sets on every request it lets through. */
export const ACCESS_HEADER = "Cf-Access-Jwt-Assertion";

/** A team's address, and nothing else, may issue a token here. */
export const ACCESS_ISSUER =
	/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/;

/** Clocks disagree a little; Access's tokens last hours. */
const LEEWAY_S = 60;

/** How long a team's published keys are used before they are asked again. */
const KEYS_FOR_MS = 60 * 60 * 1000;

/** A key the token names but the cache does not have is asked again, at most this often. */
const REFRESH_AFTER_MS = 60 * 1000;

/**
 * How long the settings are used before they are read again. Short, because
 * a deploy that finds Access turned off deletes them, and until the Worker
 * reads that it refuses every request that comes without a token.
 */
const SETTINGS_FOR_MS = 30 * 1000;

export type AccessVerdict =
	| { ok: true; audience: string[] }
	| { ok: false; reason: string; unanswered?: boolean };

interface Jwk {
	kid?: string;
	kty?: string;
	alg?: string;
	n?: string;
	e?: string;
}

/** One team's keys: a deployment has one team, so nothing else is kept. */
let cachedKeys: { issuer: string; keys: Jwk[]; at: number } | null = null;

async function loadKeys(issuer: string): Promise<Jwk[]> {
	const response = await fetch(`${issuer}/cdn-cgi/access/certs`, {
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) {
		throw new Error(`the issuer's keys answered ${response.status}`);
	}
	const body = (await response.json()) as { keys?: Jwk[] };
	return Array.isArray(body.keys) ? body.keys : [];
}

async function keyFor(
	issuer: string,
	kid: string,
	now: number,
): Promise<Jwk | null | "unanswered"> {
	const cached = cachedKeys?.issuer === issuer ? cachedKeys : null;
	const fresh = cached !== null && now - cached.at < KEYS_FOR_MS;
	const hit = cached?.keys.find((key) => key.kid === kid);
	if (hit && fresh) return hit;
	// A key the cache lacks may be a rotation, so ask -- but not on every
	// request that names an unknown key, or a sender could make each of
	// them a fetch.
	if (cached && fresh && now - cached.at < REFRESH_AFTER_MS) return null;
	try {
		const keys = await loadKeys(issuer);
		cachedKeys = { issuer, keys, at: now };
		return keys.find((key) => key.kid === kid) ?? null;
	} catch {
		// The keys could not be had: stale ones are better than none, and
		// none is a request nobody can answer yet rather than a bad one.
		return hit ?? "unanswered";
	}
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
 * Whether `token` is a token `issuer` signed, in date, for some audience.
 * Which audience is this deployment's is `checkAccess`'s question.
 */
export async function verifyAccessToken(
	token: string,
	issuer: string,
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
	// Before any key is fetched: a token naming another team is refused
	// without a request to it.
	if (claims.iss !== issuer) {
		return { ok: false, reason: "issued by another team" };
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
		? { ok: true, audience }
		: { ok: false, reason: "the signature does not verify" };
}

interface StoredSettings {
	settings: AccessSettings | null;
	etag: string | null;
}

let cachedSettings: (StoredSettings & { at: number }) | null = null;

/** For the tests: forget the settings and keys this isolate has read. */
export function forgetAccessState(): void {
	cachedSettings = null;
	cachedKeys = null;
}

/** Throws on anything it cannot read, which the gate answers 503. */
async function readSettings(env: Env, now: number): Promise<StoredSettings> {
	if (cachedSettings && now - cachedSettings.at < SETTINGS_FOR_MS) {
		return cachedSettings;
	}
	const object = await env.BUCKET.get(ACCESS_KEY);
	let stored: StoredSettings = { settings: null, etag: null };
	if (object) {
		const value = (await object.json()) as Partial<AccessSettings> | null;
		if (
			!value ||
			typeof value.issuer !== "string" ||
			!ACCESS_ISSUER.test(value.issuer) ||
			(value.audiences !== undefined &&
				(!Array.isArray(value.audiences) ||
					value.audiences.length === 0 ||
					!value.audiences.every(
						(one) => typeof one === "string" && one !== "",
					)))
		) {
			throw new Error(`${ACCESS_KEY} holds no Access team`);
		}
		stored = {
			settings: {
				issuer: value.issuer,
				...(value.audiences ? { audiences: value.audiences } : {}),
			},
			etag: object.etag,
		};
	}
	cachedSettings = { ...stored, at: now };
	return stored;
}

/**
 * Writes the audience beside a team the deploy wrote without one. Only over
 * the object that was read: if a deploy rewrote it meanwhile, or another
 * request fixed an audience first, that one stands and is read back.
 */
async function fixAudience(
	env: Env,
	stored: StoredSettings,
	audience: string,
	now: number,
): Promise<AccessSettings> {
	const issuer = stored.settings?.issuer ?? "";
	const value: AccessSettings = { issuer, audiences: [audience] };
	const written = stored.etag
		? await env.BUCKET.put(ACCESS_KEY, JSON.stringify(value), {
				onlyIf: { etagMatches: stored.etag },
				httpMetadata: { contentType: "application/json" },
			})
		: null;
	if (written) {
		cachedSettings = { settings: value, etag: written.etag, at: now };
		return value;
	}
	cachedSettings = null;
	const again = await readSettings(env, now);
	if (!again.settings)
		throw new Error(`${ACCESS_KEY} went while being written`);
	return again.settings;
}

export type AccessGate =
	| { pass: true }
	| { pass: false; status: 403 | 503; reason: string };

/**
 * Whether a request may go on, by its Access token and the settings the
 * deploy wrote. Settings that cannot be read fail closed (503): reading them
 * as "none" would let a request with no token through behind Access.
 */
export async function checkAccess(
	request: Request,
	env: Env,
	now = Date.now(),
): Promise<AccessGate> {
	let stored: StoredSettings;
	try {
		stored = await readSettings(env, now);
	} catch {
		return {
			pass: false,
			status: 503,
			reason: "the Access settings could not be read",
		};
	}
	const settings = stored.settings;
	if (!settings) return { pass: true };

	const token = request.headers.get(ACCESS_HEADER);
	if (!token) return { pass: false, status: 403, reason: "no Access token" };
	const verdict = await verifyAccessToken(token, settings.issuer, now);
	if ("reason" in verdict) {
		return {
			pass: false,
			status: verdict.unanswered ? 503 : 403,
			reason: verdict.reason,
		};
	}
	let audiences = settings.audiences;
	if (!audiences) {
		try {
			audiences = (
				await fixAudience(env, stored, verdict.audience[0] ?? "", now)
			).audiences;
		} catch {
			return {
				pass: false,
				status: 503,
				reason: "the Access settings could not be written",
			};
		}
	}
	if (!audiences?.some((one) => verdict.audience.includes(one))) {
		return { pass: false, status: 403, reason: "for another application" };
	}
	return { pass: true };
}
