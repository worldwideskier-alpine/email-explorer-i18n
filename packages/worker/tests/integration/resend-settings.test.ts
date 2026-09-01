import { env, runInDurableObject, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getResendApiKey, getResendKeySource } from "../../src/app-settings";
import {
	authenticatedFetch,
	personId,
	sessionToken,
	testAuthBeforeAll,
} from "./utils";

/**
 * The outbound mail key: one per person, settable on their own screen.
 *
 * Three properties matter more than the feature itself:
 *
 *  - the key is never sent back to a browser. Moving it out of a Worker
 *    secret and into R2 already widens who can read it; handing it to any
 *    session that asks would widen it much further, and a stolen session
 *    would become a stolen key.
 *  - one person's key is not another's. It used to be a single object for
 *    the whole deployment, which is fine with one person and silently wrong
 *    with two: the second to save one overwrote the first's, so the first
 *    then paid for the second's mail until the bill arrived.
 *  - somebody who sends nothing pays for nothing. Whose key sends a message
 *    follows from whose message it is, including the mail this application
 *    sends on their behalf.
 */

const bucket = () => (env as unknown as { BUCKET: R2Bucket }).BUCKET;
const SETTINGS_KEY = "settings/app.json";
const OWN_KEY = `settings/person/${encodeURIComponent(personId)}.json`;
const SECRET = "re_a_key_that_must_not_leak";
/** What the test pool binds as the deployment's own key. */
const FROM_ENV = "re_placeholder_for_tests";

/** A second person, with their own login and their own key. */
const OTHER_PERSON = "person-someone-else";
const plainUserToken = "another_persons_token";
async function makeOtherPerson(): Promise<void> {
	const ns = (env as unknown as { MAILBOX: DurableObjectNamespace }).MAILBOX;
	const stub = ns.get(ns.idFromName("AUTH"));
	await runInDurableObject(stub, async (_i, state) => {
		const now = Date.now();
		state.storage.sql.exec(
			"INSERT OR REPLACE into users (id, email, password_hash, is_admin, person_id, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)",
			"user2",
			"plain@example.com",
			"bb",
			0,
			OTHER_PERSON,
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

const asOtherPerson = (url: string, options: RequestInit = {}) =>
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
		await bucket().delete(OWN_KEY);
	});

	it("is used for sending once stored", async () => {
		expect(await setKey(SECRET)).toHaveProperty("status", 200);
		expect(await getResendApiKey(env as never, personId)).toBe(SECRET);
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
		expect(await getResendKeySource(bare as never, personId)).toBe("none");
		expect(await getResendApiKey(bare as never, personId)).toBeUndefined();
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

	/**
	 * The property that replaces "only an administrator may set it".
	 *
	 * Every person sets their own, so the question is no longer who may set
	 * one but whose it is. A single object for the whole deployment answered
	 * that wrongly and quietly: with one person it looks like their key, and
	 * the second person to save one overwrote it -- so the first went on
	 * sending through somebody else's Resend account, paid for by somebody
	 * who never agreed to it, until the bill arrived.
	 */
	it("keeps one person's key away from another's", async () => {
		await makeOtherPerson();
		await setKey(SECRET);

		const write = await asOtherPerson(RESEND_URL, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ apiKey: "re_belonging_to_somebody_else" }),
		});
		expect(write.status).toBe(200);

		// Each keeps their own, and neither has been replaced by the other.
		expect(await getResendApiKey(env as never, personId)).toBe(SECRET);
		expect(await getResendApiKey(env as never, OTHER_PERSON)).toBe(
			"re_belonging_to_somebody_else",
		);
	});

	// And what a person is told about the key is their own status, never a
	// hint that somebody else has one.
	it("tells each person only about their own", async () => {
		await makeOtherPerson();
		await setKey(SECRET);

		const theirs = await asOtherPerson(RESEND_URL);
		expect(await theirs.json()).toEqual({ source: "environment" });
	});

	it("is refused to anyone with no session at all", async () => {
		expect((await SELF.fetch(RESEND_URL)).status).toBe(401);
		const write = await SELF.fetch(RESEND_URL, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ apiKey: "re_set_by_a_stranger" }),
		});
		expect(write.status).toBe(401);
		expect(await getResendApiKey(env as never, personId)).toBe(FROM_ENV);
	});

	// Clearing must not store an empty string: that would send `Bearer ` and
	// fail every message with no obvious cause.
	it("clears rather than storing an empty key", async () => {
		await setKey(SECRET);
		const cleared = await setKey("");
		// Clearing does not disable sending: it hands back to the deployment.
		expect(await cleared.json()).toEqual({ source: "environment" });
		expect(await getResendApiKey(env as never, personId)).toBe(FROM_ENV);

		const stored = await bucket().get(OWN_KEY);
		expect(await stored?.json()).toEqual({});
	});

	it("prefers the stored key over the deployment's own", async () => {
		const withEnv = { ...env, RESEND_API_KEY: "re_from_the_deployment" };
		expect(await getResendApiKey(withEnv as never, personId)).toBe(
			"re_from_the_deployment",
		);

		await setKey(SECRET);
		expect(await getResendApiKey(withEnv as never, personId)).toBe(SECRET);
	});

	// A settings object that will not parse must not take sending down with
	// it, and must not be mistaken for a key either.
	it("falls back when the stored settings are unreadable", async () => {
		await bucket().put(OWN_KEY, "this is not json");
		expect(await getResendApiKey(env as never, personId)).toBe(FROM_ENV);
		expect(
			await getResendApiKey({ ...env, RESEND_API_KEY: undefined } as never, personId),
		).toBeUndefined();
	});
});
