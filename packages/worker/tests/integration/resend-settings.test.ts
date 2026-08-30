import { env, runInDurableObject, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getResendApiKey, getResendKeySource } from "../../src/app-settings";
import { authenticatedFetch, sessionToken, testAuthBeforeAll } from "./utils";

/**
 * The outbound mail key, now settable from the admin screen.
 *
 * Two properties matter more than the feature itself:
 *
 *  - the key is never sent back to a browser. Moving it out of a Worker
 *    secret and into R2 already widens who can read it; handing it to any
 *    session that asks would widen it much further, and a stolen session
 *    would become a stolen key.
 *  - only an administrator can read the status or change it. Whoever holds
 *    the key decides where every message this deployment sends actually
 *    goes.
 */

const bucket = () => (env as unknown as { BUCKET: R2Bucket }).BUCKET;
const SETTINGS_KEY = "settings/app.json";
const SECRET = "re_a_key_that_must_not_leak";
/** What the test pool binds as the deployment's own key. */
const FROM_ENV = "re_placeholder_for_tests";

/** A signed-in user who is not an administrator. */
const plainUserToken = "not_an_admin_token";
async function makePlainUser(): Promise<void> {
	const ns = (env as unknown as { MAILBOX: DurableObjectNamespace }).MAILBOX;
	const stub = ns.get(ns.idFromName("AUTH"));
	await runInDurableObject(stub, async (_i, state) => {
		const now = Date.now();
		state.storage.sql.exec(
			"INSERT OR REPLACE into users (id, email, password_hash, is_admin, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
			"user2",
			"plain@example.com",
			"bb",
			0,
			now,
			now,
		);
		state.storage.sql.exec(
			"INSERT OR REPLACE into sessions (id, user_id, expires_at, created_at) values (?, ?, ?, ?)",
			plainUserToken,
			"user2",
			now + 60_000,
			now,
		);
	});
}

const asPlainUser = (url: string, options: RequestInit = {}) =>
	SELF.fetch(url, {
		...options,
		headers: { ...options.headers, Authorization: `Bearer ${plainUserToken}` },
	});

const RESEND_URL = "http://local.test/api/v1/admin/settings/resend";

const setKey = (apiKey: string) =>
	authenticatedFetch(RESEND_URL, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ apiKey }),
	});

describe("the outbound mail API key", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await bucket().delete(SETTINGS_KEY);
	});

	it("is used for sending once stored", async () => {
		expect(await setKey(SECRET)).toHaveProperty("status", 200);
		expect(await getResendApiKey(env as never)).toBe(SECRET);
	});

	it("says where the key in use came from", async () => {
		// The pool binds a RESEND_API_KEY, standing in for the one a real
		// deployment still carries from before this screen existed.
		const before = await authenticatedFetch(RESEND_URL);
		expect(await before.json()).toEqual({ source: "environment" });

		await setKey(SECRET);
		const after = await authenticatedFetch(RESEND_URL);
		expect(await after.json()).toEqual({ source: "stored" });
	});

	it("reports none when neither source has one", async () => {
		const bare = { ...env, RESEND_API_KEY: undefined };
		expect(await getResendKeySource(bare as never)).toBe("none");
		expect(await getResendApiKey(bare as never)).toBeUndefined();
	});

	/**
	 * The assertion this file exists for. Every response the admin screen can
	 * provoke is searched for the key itself, not just the one that returns
	 * the status.
	 */
	it("never returns the key to a browser", async () => {
		const responses = [
			await setKey(SECRET),
			await authenticatedFetch(RESEND_URL),
			await setKey("re_a_replacement"),
			await authenticatedFetch(RESEND_URL),
		];
		for (const response of responses) {
			const body = await response.text();
			expect(body).not.toContain(SECRET);
			expect(body).not.toContain("re_a_replacement");
		}
	});

	// GET /api/v1/settings is public. Whether outbound mail works is not
	// something to tell someone who cannot sign in, and the key certainly is
	// not.
	it("is absent from the public settings endpoint", async () => {
		await setKey(SECRET);
		const res = await SELF.fetch("http://local.test/api/v1/settings");
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).not.toContain(SECRET);
		expect(body).not.toContain("resend");
		expect(body.toLowerCase()).not.toContain("apikey");
	});

	it("is refused to a signed-in user who is not an administrator", async () => {
		await makePlainUser();

		const read = await asPlainUser(RESEND_URL);
		expect(read.status).toBe(403);

		const write = await asPlainUser(RESEND_URL, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ apiKey: "re_set_by_a_non_admin" }),
		});
		expect(write.status).toBe(403);
		// Still the deployment's own, not the one the non-admin tried to set.
		expect(await getResendApiKey(env as never)).toBe(FROM_ENV);
	});

	it("is refused to anyone with no session at all", async () => {
		expect((await SELF.fetch(RESEND_URL)).status).toBe(401);
		const write = await SELF.fetch(RESEND_URL, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ apiKey: "re_set_by_a_stranger" }),
		});
		expect(write.status).toBe(401);
		expect(await getResendApiKey(env as never)).toBe(FROM_ENV);
	});

	// Clearing must not store an empty string: that would send `Bearer ` and
	// fail every message with no obvious cause.
	it("clears rather than storing an empty key", async () => {
		await setKey(SECRET);
		const cleared = await setKey("");
		// Clearing does not disable sending: it hands back to the deployment.
		expect(await cleared.json()).toEqual({ source: "environment" });
		expect(await getResendApiKey(env as never)).toBe(FROM_ENV);

		const stored = await bucket().get(SETTINGS_KEY);
		expect(await stored?.json()).toEqual({});
	});

	it("prefers the stored key over the deployment's own", async () => {
		const withEnv = { ...env, RESEND_API_KEY: "re_from_the_deployment" };
		expect(await getResendApiKey(withEnv as never)).toBe(
			"re_from_the_deployment",
		);

		await setKey(SECRET);
		expect(await getResendApiKey(withEnv as never)).toBe(SECRET);
	});

	// A settings object that will not parse must not take sending down with
	// it, and must not be mistaken for a key either.
	it("falls back when the stored settings are unreadable", async () => {
		await bucket().put(SETTINGS_KEY, "this is not json");
		expect(await getResendApiKey(env as never)).toBe(FROM_ENV);
		expect(
			await getResendApiKey({ ...env, RESEND_API_KEY: undefined } as never),
		).toBeUndefined();
	});
});
