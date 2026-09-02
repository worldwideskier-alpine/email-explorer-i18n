import { env, runInDurableObject, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { resetLegacyGrantMemo } from "../../src/legacy-grants";
import { LEGACY_ADMIN_PERSON_ID } from "../../src/people";

/**
 * The deployment that upgrades, reached through a route that is not the
 * mailbox list.
 *
 * Before the ownership model, an administrator reached every mailbox by
 * skipping the check, so the mailboxes in use had no owner row at all --
 * nothing pointed from a person to an address. `ensureLegacyMailboxGrants`
 * writes those rows once, from whichever request arrives first after the
 * deploy, and until it has run the question "who holds this mailbox?" answers
 * "nobody", for everybody.
 *
 * It used to be triggered from two places: listing the mailboxes, and the
 * nightly run. So a route that asked the ownership question without going
 * through either -- posting a restore straight at the import endpoint, which
 * is exactly what a script migrating mail in would do -- refused every message
 * on a deployment where nobody had opened the dashboard yet. Opening it once
 * would have fixed it, which is not something the person running the script
 * can be expected to know.
 *
 * The state below is the legacy one, built rather than described: mailboxes
 * present in the bucket with no grant rows behind them, and a login belonging
 * to the person the migration folds the old administrators into.
 */

const login = async (email: string, password = "password123") => {
	const res = await SELF.fetch("http://local.test/api/v1/auth/login", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email, password }),
	});
	return (await res.json<{ id: string }>()).id;
};

const as =
	(token: string) =>
	(url: string, options: RequestInit = {}) =>
		SELF.fetch(url, {
			...options,
			headers: { ...options.headers, Authorization: `Bearer ${token}` },
		});

function authStub() {
	// @ts-expect-error test binding
	return env.MAILBOX.get(env.MAILBOX.idFromName("AUTH"));
}

const MARKER_KEY = "system/mailbox-grants-backfilled.json";
const LEGACY_MAILBOX = "legacy-box@test.com";

const rawEmail = Buffer.from(
	[
		"From: sender@example.org",
		"Subject: brought back",
		"MIME-Version: 1.0",
		'Content-Type: text/plain; charset="utf-8"',
		"",
		"body",
		"",
	].join("\r\n"),
	"utf8",
).toString("base64");

/**
 * Root, one administrator, and a mailbox that exists in the bucket with
 * nothing pointing at it.
 *
 * The mailbox is written straight to R2 rather than created through the API,
 * because creating it through the API is what writes the owner row this is
 * about not having. The administrator is then repointed at the person the
 * migration names, which is what the migration itself does to the logins that
 * carried the old admin flag.
 */
async function setUpLegacyDeployment() {
	await SELF.fetch("http://local.test/api/v1/auth/register", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email: "root@test.com", password: "password123" }),
	});
	const rootToken = await login("root@test.com");

	const created = await as(rootToken)(
		"http://local.test/api/v1/root/accounts",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				email: "old-admin@test.com",
				password: "password123",
				role: "admin",
			}),
		},
	);
	expect(created.status).toBe(201);

	await env.BUCKET.put(`mailboxes/${LEGACY_MAILBOX}.json`, JSON.stringify({}));

	await runInDurableObject(authStub(), async (_instance, state) => {
		state.storage.sql.exec(
			"UPDATE users SET person_id = ? WHERE email = ?",
			LEGACY_ADMIN_PERSON_ID,
			"old-admin@test.com",
		);
	});

	// Nothing has run the backfill yet, which is the state a deployment is in
	// the moment it comes up.
	await env.BUCKET.delete(MARKER_KEY);
	resetLegacyGrantMemo();

	return { token: await login("old-admin@test.com") };
}

describe("a restore posted before anyone opens the dashboard", () => {
	beforeEach(() => {
		resetLegacyGrantMemo();
	});

	it("is accepted, because the ownership question brings its own backfill", async () => {
		const { token } = await setUpLegacyDeployment();

		expect(await env.BUCKET.head(MARKER_KEY)).toBeNull();

		const res = await as(token)(
			`http://local.test/api/v1/admin/mailboxes/${LEGACY_MAILBOX}/import`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ rawEmailBase64: rawEmail, folder: "inbox" }),
			},
		);

		expect(res.status).toBe(201);
		// And it ran here rather than somewhere else having run it.
		expect(await env.BUCKET.head(MARKER_KEY)).not.toBeNull();
	});

	/**
	 * The same, through the middleware that guards every /mailboxes route.
	 *
	 * It asked the Durable Object directly instead of going through
	 * personHoldsMailbox, so it never triggered the backfill -- and the one
	 * screen that would have, the mailbox list, is behind it. Opening any
	 * mailbox on an upgrading deployment answered 403 with the marker still
	 * absent, measured before this was changed.
	 */
	it("is accepted through the mailbox routes too", async () => {
		const { token } = await setUpLegacyDeployment();

		expect(await env.BUCKET.head(MARKER_KEY)).toBeNull();

		const res = await as(token)(
			`http://local.test/api/v1/mailboxes/${LEGACY_MAILBOX}/emails`,
		);

		expect(res.status).toBe(200);
		expect(await env.BUCKET.head(MARKER_KEY)).not.toBeNull();
	});

	/**
	 * The backfill is a one-time repair, not a rule, so it must not make the
	 * old person the owner of a mailbox somebody else registers afterwards.
	 * Reaching it from more routes must not change that.
	 */
	it("still does not hand them anything registered later", async () => {
		const { token } = await setUpLegacyDeployment();

		await as(token)(
			`http://local.test/api/v1/admin/mailboxes/${LEGACY_MAILBOX}/import`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ rawEmailBase64: rawEmail, folder: "inbox" }),
			},
		);

		const rootToken = await login("root@test.com");
		await as(rootToken)("http://local.test/api/v1/root/accounts", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				email: "newcomer@test.com",
				password: "password123",
				role: "admin",
			}),
		});
		const newcomer = await login("newcomer@test.com");
		await as(newcomer)("http://local.test/api/v1/mailboxes", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: "new-box@test.com", name: "New" }),
		});

		const res = await as(token)(
			"http://local.test/api/v1/admin/mailboxes/new-box@test.com/import",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ rawEmailBase64: rawEmail, folder: "inbox" }),
			},
		);
		expect(res.status).toBe(403);
	});
});
