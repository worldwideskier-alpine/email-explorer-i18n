import { env, runInDurableObject, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { resetLegacyGrantMemo } from "../../src/legacy-grants";
import { LEGACY_ADMIN_PERSON_ID } from "../../src/people";

/**
 * The backfill's escape hatch, and what it reaches when it fires.
 *
 * `ensureLegacyMailboxGrants` normally refuses to run twice -- a marker in the
 * bucket says it is done, and repeating it would mean the old person owning
 * every mailbox for ever. One state overrides the marker: the legacy person
 * holds nothing while mailboxes exist, which is meant to describe a deployment
 * whose mail has vanished from every screen.
 *
 * But "holds nothing" is also what happens when that person deletes their last
 * mailbox on purpose. And the run does not restore what they used to hold: it
 * lists every mailbox in the bucket and grants all of them. So the two facts
 * meet at somebody else's mail.
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

const rawEmail = Buffer.from(
	["From: s@example.org", "Subject: x", "", "body", ""].join("\r\n"),
	"utf8",
).toString("base64");

const importInto = (token: string, mailbox: string) =>
	as(token)(`http://local.test/api/v1/admin/mailboxes/${mailbox}/import`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ rawEmailBase64: rawEmail, folder: "inbox" }),
	});

describe("the backfill firing a second time", () => {
	beforeEach(() => {
		resetLegacyGrantMemo();
	});

	it("does not hand the legacy person a mailbox somebody else registered", async () => {
		// A deployment in the legacy state: one mailbox in the bucket with no
		// owner row, and a login belonging to the person the migration names.
		await SELF.fetch("http://local.test/api/v1/auth/register", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: "root@test.com", password: "password123" }),
		});
		const rootToken = await login("root@test.com");
		await as(rootToken)("http://local.test/api/v1/root/accounts", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				email: "old@test.com",
				password: "password123",
				role: "admin",
			}),
		});
		await env.BUCKET.put("mailboxes/old-box@test.com.json", "{}");
		await runInDurableObject(authStub(), async (_i, state) => {
			state.storage.sql.exec(
				"UPDATE users SET person_id = ? WHERE email = ?",
				LEGACY_ADMIN_PERSON_ID,
				"old@test.com",
			);
		});
		await env.BUCKET.delete(MARKER_KEY);
		resetLegacyGrantMemo();

		const oldToken = await login("old@test.com");
		// First run: the repair this exists for.
		expect((await importInto(oldToken, "old-box@test.com")).status).toBe(201);

		// Somebody else joins and registers a mailbox of their own.
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
		expect(
			(
				await as(newcomer)("http://local.test/api/v1/mailboxes", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ email: "new-box@test.com", name: "New" }),
				})
			).status,
		).toBe(201);

		// The lock is on by default; a person turning it off is the ordinary
		// way to delete a mailbox they no longer want.
		expect(
			(
				await as(oldToken)(
					"http://local.test/api/v1/mailboxes/old-box@test.com",
					{
						method: "PUT",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ settings: { deletionLocked: false } }),
					},
				)
			).status,
		).toBe(200);

		// The old person tidies up and deletes the one mailbox they hold. Now
		// they hold nothing -- which is the state the marker override reads as
		// "this deployment has lost its grants".
		expect(
			(
				await as(oldToken)(
					"http://local.test/api/v1/mailboxes/old-box@test.com?purge=true",
					{ method: "DELETE" },
				)
			).status,
		).toBe(204);

		// A cold isolate, which is all it takes for the memo to be gone.
		resetLegacyGrantMemo();

		expect((await importInto(oldToken, "new-box@test.com")).status).toBe(403);
	});
});
