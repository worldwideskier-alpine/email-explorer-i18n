import { env, runInDurableObject, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { resetLegacyGrantMemo } from "../../src/legacy-grants";

/**
 * The `is_admin` column decides nothing any more.
 *
 * It used to decide everything: an account carrying the flag skipped the
 * ownership check and reached every mailbox in the deployment. That was
 * replaced by the question "does this person hold this mailbox", and the flag
 * was left in place -- `register` still writes it, the login response still
 * carries it -- because removing a column from a live deployment's users is a
 * migration with nothing to gain.
 *
 * Left in place, it is a loaded gun: it is still written, still read back into
 * the session, and `if (session.isAdmin)` would compile anywhere in the
 * request path and restore the old behaviour silently. What would notice is a
 * test, and the ones that exist do not quite say this. They set their people
 * up through root, which writes the flag off, so they hold "a person without
 * the flag cannot reach somebody else's mail" -- which a reinstated bypass
 * would not contradict. The one flagged account they do exercise is root, and
 * root being refused reads as a rule about root.
 *
 * So: an account with the flag on, and nothing else about it special.
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

const authDO = () => env.MAILBOX.get(env.MAILBOX.idFromName("AUTH"));

/** Whether the stored row really carries the flag, since that is the premise. */
async function storedFlag(email: string): Promise<number | undefined> {
	return runInDurableObject(authDO(), async (_instance, state) => {
		const rows = state.storage.sql
			.exec("SELECT is_admin FROM users WHERE email = ?", email)
			.toArray();
		return rows[0]?.is_admin as number | undefined;
	});
}

async function setUp() {
	// Root first: registration closes behind the first account.
	await SELF.fetch("http://local.test/api/v1/auth/register", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email: "root@test.com", password: "password123" }),
	});
	const rootToken = await login("root@test.com");

	// Somebody with mail of their own, made the ordinary way.
	const created = await as(rootToken)(
		"http://local.test/api/v1/root/accounts",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				email: "owner@test.com",
				password: "password123",
				role: "admin",
			}),
		},
	);
	expect(created.status).toBe(201);
	const ownerToken = await login("owner@test.com");
	const made = await as(ownerToken)("http://local.test/api/v1/mailboxes", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email: "theirs@test.com", name: "Theirs" }),
	});
	expect(made.status).toBe(201);

	// And the account this is about: the flag on, its own person, no mailbox.
	// Written through the auth object because nothing on the site sets the
	// flag any more -- which is the point, and also why it has to be done here.
	await authDO().register("flagged@test.com", "password123", true);
	const flaggedToken = await login("flagged@test.com");

	return { flaggedToken };
}

describe("an account still carrying the legacy admin flag", () => {
	let flaggedToken: string;

	beforeEach(async () => {
		resetLegacyGrantMemo();
		({ flaggedToken } = await setUp());
		// The premise, asserted rather than assumed: a test for what the flag
		// does is empty if the flag is off.
		expect(await storedFlag("flagged@test.com")).toBe(1);
	});

	it("is shown no mailboxes, because it holds none", async () => {
		const res = await as(flaggedToken)("http://local.test/api/v1/mailboxes");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual([]);
	});

	it("cannot open somebody else's mailbox", async () => {
		const res = await as(flaggedToken)(
			"http://local.test/api/v1/mailboxes/theirs@test.com",
		);
		expect(res.status).toBe(403);
	});

	// The sub-routes are where the mail actually is, and they are gated by the
	// same middleware. A bypass put back in one place and not the other is
	// still a bypass.
	it("cannot read, write or restore into it either", async () => {
		const base = "http://local.test/api/v1/mailboxes/theirs@test.com";
		const attempts: [string, RequestInit][] = [
			[`${base}/emails?folder=inbox`, {}],
			[`${base}/backups`, {}],
			[`${base}/export`, {}],
			[
				`${base}/emails`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ to: "x@test.com", subject: "s", body: "b" }),
				},
			],
			[
				"http://local.test/api/v1/admin/mailboxes/theirs@test.com/import",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ rawEmailBase64: btoa("From: a@b\r\n\r\nhi") }),
				},
			],
		];
		for (const [url, options] of attempts) {
			expect((await as(flaggedToken)(url, options)).status, url).toBe(403);
		}
	});

	// Root's screen is a different gate -- the role, not the flag -- and the
	// flag must not open that either.
	it("is not root", async () => {
		expect(
			(await as(flaggedToken)("http://local.test/api/v1/root/accounts")).status,
		).toBe(403);
	});
});
