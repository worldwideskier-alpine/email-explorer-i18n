import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * A person cannot be deleted while their lock is on.
 *
 * Deleting a person is the largest irreversible act in this application: it
 * takes their logins, their mailboxes, the mail in them, the raw copies, the
 * attachments and every nightly archive, and nothing brings any of it back.
 * On the account screen that button sat one touch from the refresh link, on a
 * phone, beside the row for somebody else.
 *
 * So it is two acts now, the same shape a mailbox has had all along: turn the
 * lock off, then delete. The lock is not a permission -- root can turn it off
 * and delete a second later -- and pretending otherwise would be the wrong
 * claim to make about it. What it buys is that the act which cannot be undone
 * cannot be the one that happens by accident.
 *
 * Held here rather than on the screen because the screen is not the boundary:
 * it hides the button, and a request typed by hand does not go through it.
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

interface Person {
	personId: string;
	emails: string[];
	role: "root" | "admin";
	deletionLocked: boolean;
}

const people = async (token: string): Promise<Person[]> => {
	const res = await as(token)("http://local.test/api/v1/root/accounts");
	expect(res.status).toBe(200);
	return res.json<Person[]>();
};

const setLock = (token: string, personId: string, locked: boolean) =>
	as(token)(`http://local.test/api/v1/root/accounts/${personId}/lock`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ locked }),
	});

let rootToken: string;
let ownerToken: string;
let owner: Person;

beforeEach(async () => {
	// The first account registered is root; registration closes behind it.
	await SELF.fetch("http://local.test/api/v1/auth/register", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email: "root@test.com", password: "password123" }),
	});
	rootToken = await login("root@test.com");

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

	ownerToken = await login("owner@test.com");
	const made = await as(ownerToken)("http://local.test/api/v1/mailboxes", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email: "theirs@test.com", name: "Theirs" }),
	});
	expect(made.status).toBe(201);

	const found = (await people(rootToken)).find((p) => p.role === "admin");
	expect(found).toBeDefined();
	owner = found as Person;
});

describe("the lock on a person", () => {
	/**
	 * Nobody switched this on. It is on because the flag is absent, and the
	 * only safe reading of an absent flag is "protected" -- every person
	 * stored before this existed has none, and the other reading makes them
	 * all deletable in one touch on the day it deploys.
	 */
	it("is on for everyone without anyone setting it", async () => {
		const list = await people(rootToken);
		expect(list.length).toBeGreaterThan(1);
		expect(list.every((person) => person.deletionLocked)).toBe(true);
	});

	it("refuses the deletion while it is on", async () => {
		const res = await as(rootToken)(
			`http://local.test/api/v1/root/accounts/${owner.personId}`,
			{ method: "DELETE" },
		);
		expect(res.status).toBe(423);

		// The refusal has to be a refusal, not a message: the person and the
		// mailbox they hold are both still there.
		expect((await people(rootToken)).map((p) => p.personId)).toContain(
			owner.personId,
		);
		const mailbox = await as(ownerToken)(
			"http://local.test/api/v1/mailboxes/theirs@test.com",
		);
		expect(mailbox.status).toBe(200);
	});

	it("lets the deletion through once it is off", async () => {
		const unlocked = await setLock(rootToken, owner.personId, false);
		expect(unlocked.status).toBe(200);

		const list = await people(rootToken);
		expect(
			list.find((p) => p.personId === owner.personId)?.deletionLocked,
		).toBe(false);

		const res = await as(rootToken)(
			`http://local.test/api/v1/root/accounts/${owner.personId}`,
			{ method: "DELETE" },
		);
		expect(res.status).toBe(200);
		expect((await people(rootToken)).map((p) => p.personId)).not.toContain(
			owner.personId,
		);
	});

	it("can be put back on, and refuses again", async () => {
		expect((await setLock(rootToken, owner.personId, false)).status).toBe(200);
		expect((await setLock(rootToken, owner.personId, true)).status).toBe(200);

		const res = await as(rootToken)(
			`http://local.test/api/v1/root/accounts/${owner.personId}`,
			{ method: "DELETE" },
		);
		expect(res.status).toBe(423);
	});
});

describe("who may move it", () => {
	it("is root and nobody else", async () => {
		const res = await setLock(ownerToken, owner.personId, false);
		expect(res.status).toBe(403);

		// And the refusal did not quietly do it anyway.
		const list = await people(rootToken);
		expect(
			list.find((p) => p.personId === owner.personId)?.deletionLocked,
		).toBe(true);
	});

	it("is nobody at all without a session", async () => {
		const res = await SELF.fetch(
			`http://local.test/api/v1/root/accounts/${owner.personId}/lock`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ locked: false }),
			},
		);
		expect(res.status).toBe(401);
	});

	/**
	 * Root's own person has no delete route to guard, so a lock there would
	 * protect nothing while suggesting it did.
	 */
	it("is refused on root's own person", async () => {
		const rootPerson = (await people(rootToken)).find((p) => p.role === "root");
		expect(rootPerson).toBeDefined();
		const res = await setLock(
			rootToken,
			(rootPerson as Person).personId,
			false,
		);
		expect(res.status).toBe(409);
	});

	it("is refused for somebody who is not there", async () => {
		const res = await setLock(rootToken, "no-such-person", false);
		expect(res.status).toBe(404);
	});
});
