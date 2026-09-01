import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { resetLegacyGrantMemo } from "../../src/legacy-grants";

/**
 * What the admin screen is told about each account, and what it may do to it.
 *
 * The screen printed one of two words -- administrator or user -- from the
 * `isAdmin` flag. Root is deliberately not an administrator: its job is the
 * account list, not the mail. So the account at the top of the hierarchy was
 * shown at the bottom of it, in the same column, next to the accounts it
 * created. That is not a wording problem. The flag simply cannot say which of
 * three roles an account holds, and the answer has to come from the Worker,
 * which is the only side that knows who root is.
 *
 * The shape set up below is the shape a live deployment is actually in: the
 * first account registered is an administrator, and root is a separate account
 * made later that never was one.
 */

async function register(email: string, password = "password123") {
	return SELF.fetch("http://local.test/api/v1/auth/register", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email, password }),
	});
}

/** Registration closes behind the first account, so the rest are made directly. */
async function createUser(email: string, isAdmin: boolean): Promise<string> {
	const stub = env.MAILBOX.get(env.MAILBOX.idFromName("AUTH"));
	const user = await stub.register(email, "password123", isAdmin);
	return user.id;
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

type Listed = { id: string; email: string; isAdmin: boolean; role: string };

describe("the role the admin screen is given for each account", () => {
	let adminToken: string;
	let rootId: string;

	beforeEach(async () => {
		resetLegacyGrantMemo();

		// The first account registered: an administrator, and root until the
		// role is handed on.
		await register("operator@example.com");
		const first = await signIn("operator@example.com");

		// The account the role is handed to. Not an administrator -- it has no
		// business on this screen, which is exactly why the flag mislabels it.
		rootId = await createUser("owner@example.com", false);
		await as(first.id)("http://local.test/api/v1/root/transfer", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ userId: rootId }),
		});

		await createUser("reader@example.com", false);
		adminToken = first.id;
	});

	async function listed(): Promise<Listed[]> {
		const res = await as(adminToken)(
			"http://local.test/api/v1/auth/admin/users",
		);
		expect(res.status).toBe(200);
		return res.json<Listed[]>();
	}

	it("says root of the account that holds it", async () => {
		const users = await listed();
		expect(users.find((u) => u.email === "owner@example.com")?.role).toBe(
			"root",
		);
	});

	// The defect itself: root arrived with `isAdmin` false and was displayed
	// as the lowest of the three roles, alongside an account it can delete.
	it("does not put root in with the accounts that only read mail", async () => {
		const users = await listed();
		const root = users.find((u) => u.email === "owner@example.com");
		expect(root?.isAdmin).toBe(false);
		expect(root?.role).not.toBe("member");
	});

	it("still separates an administrator from someone with neither role", async () => {
		const users = await listed();
		expect(users.find((u) => u.email === "operator@example.com")?.role).toBe(
			"admin",
		);
		expect(users.find((u) => u.email === "reader@example.com")?.role).toBe(
			"member",
		);
	});

	/**
	 * An administrator changing the flag on root would not take the role away
	 * -- root is a row in `app_roles`, not a flag -- but the screen offering
	 * the action says the hierarchy runs the other way, and the button was
	 * sitting right there on root's row.
	 */
	it("refuses an administrator who tries to change root", async () => {
		const res = await as(adminToken)(
			`http://local.test/api/v1/auth/admin/users/${rootId}`,
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ isAdmin: true }),
			},
		);
		expect(res.status).toBe(403);

		const users = await listed();
		expect(users.find((u) => u.id === rootId)?.isAdmin).toBe(false);
	});

	// And it is only root that is out of reach: the rest of the list still works.
	it("still lets an administrator change an ordinary account", async () => {
		const users = await listed();
		const readerId = users.find((u) => u.email === "reader@example.com")?.id;
		const res = await as(adminToken)(
			`http://local.test/api/v1/auth/admin/users/${readerId}`,
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ isAdmin: true }),
			},
		);
		expect(res.status).toBe(200);
	});
});

/**
 * A deployment that has not named a root yet -- which every deployment is
 * until the first registration, and which an upgrading one passes through.
 * Nothing is root, so nothing is labelled root.
 */
describe("before a root exists", () => {
	it("labels every account by the flag alone", async () => {
		resetLegacyGrantMemo();
		const stub = env.MAILBOX.get(env.MAILBOX.idFromName("AUTH"));
		await stub.register("operator@example.com", "password123", true);
		await stub.register("reader@example.com", "password123", false);
		const session = await signIn("operator@example.com");

		const users = await (
			await as(session.id)("http://local.test/api/v1/auth/admin/users")
		).json<Listed[]>();

		expect(users.map((u) => u.role).sort()).toEqual(["admin", "member"]);
	});
});
