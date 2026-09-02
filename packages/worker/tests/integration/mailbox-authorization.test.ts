import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { resetLegacyGrantMemo } from "../../src/legacy-grants";

/**
 * Who can reach which mailbox (originally issue #19).
 *
 * The question used to be answered by a flag: an account carrying `is_admin`
 * skipped the check entirely and reached every mailbox in the deployment,
 * while everybody else was checked against grants somebody had to hand out.
 * That reads as "my own estate" only while the deployment holds one person.
 * With two, the second -- given an account so they could keep their own
 * addresses -- was handed the first's mail, and nothing in the stored data
 * could tell the two situations apart.
 *
 * It is now answered by the person: a mailbox belongs to whoever registered
 * it, and every login of that person reaches it. Nobody hands anything to
 * anybody, so there is no lifecycle of granting and revoking to test; there
 * is only whose it is.
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

/** Root, and two unrelated people, each with one address of their own. */
async function setUpTwoPeople() {
	await SELF.fetch("http://local.test/api/v1/auth/register", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email: "root@test.com", password: "password123" }),
	});
	const rootToken = await login("root@test.com");

	for (const email of ["first@test.com", "second@test.com"]) {
		const created = await as(rootToken)(
			"http://local.test/api/v1/root/accounts",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ email, password: "password123", role: "admin" }),
			},
		);
		expect(created.status).toBe(201);
	}

	const firstToken = await login("first@test.com");
	const secondToken = await login("second@test.com");

	for (const [token, address] of [
		[firstToken, "theirs@test.com"],
		[secondToken, "mine@test.com"],
	] as const) {
		const made = await as(token)("http://local.test/api/v1/mailboxes", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: address, name: address }),
		});
		expect(made.status).toBe(201);
	}

	return { rootToken, firstToken, secondToken };
}

const listed = async (token: string): Promise<string[]> => {
	const res = await as(token)("http://local.test/api/v1/mailboxes");
	expect(res.status).toBe(200);
	return (await res.json<Array<{ id: string }>>()).map((m) => m.id).sort();
};

describe("which mailboxes a person is shown", () => {
	beforeEach(() => {
		resetLegacyGrantMemo();
	});

	it("shows each person the ones they registered", async () => {
		const { firstToken, secondToken } = await setUpTwoPeople();
		expect(await listed(firstToken)).toEqual(["theirs@test.com"]);
		expect(await listed(secondToken)).toEqual(["mine@test.com"]);
	});

	/**
	 * Root manages the people, not their mail. There is no route here that
	 * returns a message, a subject or a sender, and the mailbox list is the
	 * same: the person who can create and delete every account is not also a
	 * second pair of eyes on every conversation.
	 */
	it("shows root nothing", async () => {
		const { rootToken } = await setUpTwoPeople();
		expect(await listed(rootToken)).toEqual([]);
	});
});

describe("reaching a mailbox directly", () => {
	beforeEach(() => {
		resetLegacyGrantMemo();
	});

	it("lets a person open their own", async () => {
		const { firstToken } = await setUpTwoPeople();
		const res = await as(firstToken)(
			"http://local.test/api/v1/mailboxes/theirs@test.com",
		);
		expect(res.status).toBe(200);
	});

	it("refuses somebody else's", async () => {
		const { secondToken } = await setUpTwoPeople();
		const res = await as(secondToken)(
			"http://local.test/api/v1/mailboxes/theirs@test.com",
		);
		expect(res.status).toBe(403);
	});

	// The sub-routes are where the mail actually is, so they are checked the
	// same way rather than trusting that the list already filtered.
	it("refuses somebody else's sub-routes too", async () => {
		const { secondToken } = await setUpTwoPeople();
		for (const path of ["emails", "folders", "contacts"]) {
			const res = await as(secondToken)(
				`http://local.test/api/v1/mailboxes/theirs@test.com/${path}`,
			);
			expect(res.status).toBe(403);
		}
	});

	it("refuses root, which holds none of them", async () => {
		const { rootToken } = await setUpTwoPeople();
		const res = await as(rootToken)(
			"http://local.test/api/v1/mailboxes/theirs@test.com",
		);
		expect(res.status).toBe(403);
	});

	it("refuses anyone with no session at all", async () => {
		await setUpTwoPeople();
		const res = await SELF.fetch(
			"http://local.test/api/v1/mailboxes/theirs@test.com/emails",
		);
		expect(res.status).toBe(401);
	});
});

describe("a person's other login", () => {
	beforeEach(() => {
		resetLegacyGrantMemo();
	});

	/**
	 * The reason a second login exists: it is not a lesser account waiting to
	 * be granted things. It reaches what its person already holds, from the
	 * moment it is added, without anybody pressing anything.
	 */
	it("reaches everything the first one does", async () => {
		const { firstToken } = await setUpTwoPeople();

		await as(firstToken)("http://local.test/api/v1/auth/admin/register", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				email: "first-spare@test.com",
				password: "password123",
			}),
		});
		const spareToken = await login("first-spare@test.com");

		expect(await listed(spareToken)).toEqual(["theirs@test.com"]);
		expect(
			(
				await as(spareToken)(
					"http://local.test/api/v1/mailboxes/theirs@test.com/emails",
				)
			).status,
		).toBe(200);
	});

	it("still reaches nothing of anybody else's", async () => {
		const { firstToken } = await setUpTwoPeople();
		await as(firstToken)("http://local.test/api/v1/auth/admin/register", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				email: "first-spare@test.com",
				password: "password123",
			}),
		});
		const spareToken = await login("first-spare@test.com");

		expect(await listed(spareToken)).not.toContain("mine@test.com");
		expect(
			(await as(spareToken)("http://local.test/api/v1/mailboxes/mine@test.com"))
				.status,
		).toBe(403);
	});
});
