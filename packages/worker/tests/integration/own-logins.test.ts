import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { resetLegacyGrantMemo } from "../../src/legacy-grants";

/**
 * What the account screen shows, and to whom.
 *
 * It used to answer with every account in the deployment, and print a role
 * beside each. Both were wrong in the same way. On a deployment with one
 * person the list reads as "my logins" and looks harmless; with two, it hands
 * each of them the other's address, and it showed root's address -- the
 * account that can delete them -- to the people root can delete. The role
 * column then had to name three tiers using a two-state flag, and put root,
 * which is deliberately not an administrator, at the bottom.
 *
 * The list is now the signed-in person's own logins. Root cannot appear in
 * it, because root is somebody else; neither can another administrator. There
 * is nothing left for a role column to distinguish, because every row is you.
 */

async function register(email: string, password = "password123") {
	return SELF.fetch("http://local.test/api/v1/auth/register", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email, password }),
	});
}

async function signIn(email: string, password = "password123") {
	const res = await SELF.fetch("http://local.test/api/v1/auth/login", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email, password }),
	});
	return res.json<{ id: string; role?: string }>();
}

function as(token: string) {
	return (url: string, options: RequestInit = {}) =>
		SELF.fetch(url, {
			...options,
			headers: { ...options.headers, Authorization: `Bearer ${token}` },
		});
}

const authStub = () => env.MAILBOX.get(env.MAILBOX.idFromName("AUTH"));

type Listed = { id: string; email: string; role: string };

async function listedBy(token: string): Promise<Listed[]> {
	const res = await as(token)("http://local.test/api/v1/auth/admin/users");
	expect(res.status).toBe(200);
	return res.json<Listed[]>();
}

describe("the list of logins on the account screen", () => {
	let rootToken: string;
	let personToken: string;

	beforeEach(async () => {
		resetLegacyGrantMemo();

		// The first account registered runs the deployment.
		await register("root@example.com");
		rootToken = (await signIn("root@example.com")).id;

		// Somebody root created, with a spare login of their own.
		const created = await as(rootToken)(
			"http://local.test/api/v1/root/accounts",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					email: "person@example.com",
					password: "password123",
					role: "admin",
				}),
			},
		);
		expect(created.status).toBe(201);
		personToken = (await signIn("person@example.com")).id;
		await as(personToken)("http://local.test/api/v1/auth/admin/register", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				email: "person-spare@example.com",
				password: "password123",
			}),
		});

		// And a second, unrelated person.
		await as(rootToken)("http://local.test/api/v1/root/accounts", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				email: "other@example.com",
				password: "password123",
				role: "admin",
			}),
		});
	});

	it("shows exactly the signed-in person's own logins", async () => {
		expect((await listedBy(personToken)).map((u) => u.email).sort()).toEqual([
			"person-spare@example.com",
			"person@example.com",
		]);
	});

	// The defect this replaces: root's address was on the customers' screen.
	it("never shows root", async () => {
		const emails = (await listedBy(personToken)).map((u) => u.email);
		expect(emails).not.toContain("root@example.com");
	});

	it("never shows another person", async () => {
		const emails = (await listedBy(personToken)).map((u) => u.email);
		expect(emails).not.toContain("other@example.com");
	});

	// Every row is you, so there is one role and nothing to tell apart.
	it("gives every row the same role", async () => {
		const roles = new Set((await listedBy(personToken)).map((u) => u.role));
		expect([...roles]).toEqual(["admin"]);
	});

	// Root sees its own logins here too, on the same terms as anybody else.
	it("shows root its own login and nobody else's", async () => {
		expect((await listedBy(rootToken)).map((u) => u.email)).toEqual([
			"root@example.com",
		]);
	});
});

describe("removing one of your own logins", () => {
	let personToken: string;
	let spareId: string;

	beforeEach(async () => {
		resetLegacyGrantMemo();
		await register("person@example.com");
		personToken = (await signIn("person@example.com")).id;
		const added = await as(personToken)(
			"http://local.test/api/v1/auth/admin/register",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					email: "spare@example.com",
					password: "password123",
				}),
			},
		);
		spareId = (await added.json<{ id: string }>()).id;
	});

	it("removes a spare, and it can no longer sign in", async () => {
		const res = await as(personToken)(
			`http://local.test/api/v1/auth/admin/users/${spareId}`,
			{ method: "DELETE" },
		);
		expect(res.status).toBe(204);

		const attempt = await SELF.fetch("http://local.test/api/v1/auth/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				email: "spare@example.com",
				password: "password123",
			}),
		});
		expect(attempt.status).not.toBe(200);
	});

	// A person with no way in is a person nobody can reach or delete.
	it("refuses the last one", async () => {
		await as(personToken)(
			`http://local.test/api/v1/auth/admin/users/${spareId}`,
			{ method: "DELETE" },
		);
		const me = (await listedBy(personToken))[0];
		const res = await as(personToken)(
			`http://local.test/api/v1/auth/admin/users/${me.id}`,
			{ method: "DELETE" },
		);
		expect(res.status).toBe(409);
	});

	/**
	 * The boundary. "Yours" is decided by the person, not by carrying a flag
	 * -- which is what let the old screen reach strangers.
	 */
	it("refuses somebody else's login", async () => {
		const stranger = await authStub().register(
			"stranger@example.com",
			"password123",
			false,
		);
		const res = await as(personToken)(
			`http://local.test/api/v1/auth/admin/users/${stranger.id}`,
			{ method: "DELETE" },
		);
		expect(res.status).toBe(403);
	});
});
