/**
 * Cloudflare Turnstile in front of the forms a stranger can reach: signing
 * in, registering, and asking for a reset link.
 *
 * Off until root sets it, on `/root`, and set only by a pair that has been
 * seen to work: the widget has to render with the site key on that very
 * screen and its token has to pass siteverify with the secret (see
 * `rememberVerifiedPair`). A wrong pair saved unchecked would refuse every
 * sign-in -- root's too, with no screen left to undo it from.
 *
 * Like every other setting of this deployment it lives in the bucket, not in
 * a Worker secret: whoever forks this sets it on the deployed site.
 */

import type { Env } from "./types";

/** The pair in force. Its presence is what turns the check on. */
export const TURNSTILE_KEY = "settings/turnstile.json";

/**
 * A pair that has just passed siteverify on `/root` and is waiting for root
 * to press save. A token passes siteverify once, so the save cannot check the
 * same token again; it checks that what it is given is what passed.
 */
export const TURNSTILE_VERIFIED_KEY = "settings/turnstile-verified.json";

/** How long a passed check stays good for the save that follows it. */
export const VERIFIED_FOR_MS = 60 * 60 * 1000;

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** Long enough for a slow answer, short enough that a sign-in is not held. */
const SITEVERIFY_TIMEOUT_MS = 10_000;

export interface TurnstileKeys {
	siteKey: string;
	secretKey: string;
}

/**
 * The pair in force, or undefined. Never throws: a read that fails leaves the
 * forms as they are without Turnstile, rather than refusing everyone because
 * the bucket had a bad moment. The throttle still stands behind them.
 */
export async function storedTurnstile(
	env: Pick<Env, "BUCKET">,
): Promise<TurnstileKeys | undefined> {
	return readPair(env, TURNSTILE_KEY);
}

async function readPair(
	env: Pick<Env, "BUCKET">,
	key: string,
): Promise<(TurnstileKeys & { verifiedAt?: number }) | undefined> {
	try {
		const object = await env.BUCKET?.get(key);
		if (!object) return undefined;
		const stored = await object.json<Record<string, unknown>>();
		const { siteKey, secretKey, verifiedAt } = stored ?? {};
		if (typeof siteKey !== "string" || typeof secretKey !== "string") {
			return undefined;
		}
		if (!siteKey || !secretKey) return undefined;
		return {
			siteKey,
			secretKey,
			verifiedAt: typeof verifiedAt === "number" ? verifiedAt : undefined,
		};
	} catch {
		return undefined;
	}
}

/**
 * What siteverify said.
 *
 * - `passed`: the token is good.
 * - `secret-invalid`: Cloudflare does not know the secret at all
 *   (`invalid-input-secret`) -- the widget was deleted or its secret rotated.
 *   Nothing a visitor sends can bring this about.
 * - `refused`: anything else Cloudflare said no to, a missing token included.
 * - `unanswered`: no usable answer came back.
 */
export type Verdict = "passed" | "secret-invalid" | "refused" | "unanswered";

export interface SiteverifyResult {
	verdict: Verdict;
	codes: string[];
}

export async function siteverify(
	secret: string,
	token: string,
	remoteIp?: string | null,
): Promise<SiteverifyResult> {
	const form = new URLSearchParams({ secret, response: token });
	if (remoteIp) form.set("remoteip", remoteIp);

	let answer: { success?: unknown; "error-codes"?: unknown };
	try {
		const response = await fetch(SITEVERIFY, {
			method: "POST",
			body: form,
			signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS),
		});
		answer = await response.json();
	} catch (error) {
		return { verdict: "unanswered", codes: [String(error)] };
	}

	const codes = Array.isArray(answer?.["error-codes"])
		? answer["error-codes"].filter((c): c is string => typeof c === "string")
		: [];
	if (answer?.success === true) return { verdict: "passed", codes };
	if (codes.includes("invalid-input-secret")) {
		return { verdict: "secret-invalid", codes };
	}
	if (answer?.success === false) return { verdict: "refused", codes };
	return { verdict: "unanswered", codes };
}

/** Sent in place of a token that did not come; see turnstileRefusal. */
const NO_TOKEN = "no-token";

/**
 * Null when the request may go on; otherwise the response to send.
 *
 * Asked before the throttle, so a request with no good token spends nobody's
 * attempts: without this order a bot that cannot pass could still lock a real
 * address out by failing at it.
 *
 * Siteverify is asked even when there is no token, and asked *with* one: a
 * stand-in (NO_TOKEN). A widget deleted in the Cloudflare dashboard renders
 * nothing, so its sign-in page sends no token -- and siteverify, asked with
 * none, says only `missing-input-response`, never that the secret is unknown.
 * Measured on 2026-09-29 from a GitHub runner: an unknown secret answers
 * `invalid-input-secret` with any token and `missing-input-response` without
 * one. Without the stand-in, the one answer that must not refuse never came
 * back for the one case that needed it, and a deleted widget locked everyone
 * out, root included. With it, a known secret still refuses the stand-in
 * (`invalid-input-response`), so a request with no token is still refused.
 */
export async function turnstileRefusal(
	env: Pick<Env, "BUCKET">,
	request: Request,
	token: string | undefined,
): Promise<Response | null> {
	const keys = await storedTurnstile(env);
	if (!keys) return null;

	const result = await siteverify(
		keys.secretKey,
		token || NO_TOKEN,
		request.headers.get("CF-Connecting-IP"),
	);
	if (result.verdict === "passed") return null;
	if (result.verdict === "secret-invalid") {
		// Let through. Refusing here refuses root too, and the screen that
		// would put it right is behind the sign-in this is refusing. The
		// throttle still stands; the log says why the check was skipped.
		console.error(
			"Turnstile: the stored secret is not valid; letting the request through",
		);
		return null;
	}
	if (result.verdict === "unanswered") {
		console.error("Turnstile: siteverify gave no answer", result.codes);
	}
	return Response.json({ error: "Bot check failed" }, { status: 403 });
}

/** Called by `/root` when a pair has passed; see TURNSTILE_VERIFIED_KEY. */
export async function rememberVerifiedPair(
	env: Pick<Env, "BUCKET">,
	keys: TurnstileKeys,
): Promise<void> {
	await env.BUCKET.put(
		TURNSTILE_VERIFIED_KEY,
		JSON.stringify({ ...keys, verifiedAt: Date.now() }),
	);
}

/** Whether this exact pair passed on `/root` within VERIFIED_FOR_MS. */
export async function pairWasVerified(
	env: Pick<Env, "BUCKET">,
	keys: TurnstileKeys,
): Promise<boolean> {
	const verified = await readPair(env, TURNSTILE_VERIFIED_KEY);
	if (!verified?.verifiedAt) return false;
	return (
		verified.siteKey === keys.siteKey &&
		verified.secretKey === keys.secretKey &&
		Date.now() - verified.verifiedAt <= VERIFIED_FOR_MS
	);
}

/** The last four characters, which is all the screen shows of a secret. */
export function secretTail(secret: string): string {
	return secret.length >= 12 ? `...${secret.slice(-4)}` : "...";
}
