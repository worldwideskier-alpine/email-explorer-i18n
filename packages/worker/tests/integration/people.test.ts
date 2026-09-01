import { env, runInDurableObject, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { resetLegacyGrantMemo } from "../../src/legacy-grants";

/**
 * Whose mailbox it is.
 *
 * A row in `users` is a login, not a person. One person holds several of
 * them, so that losing the address they sign in with does not lock them out,
 * and the logins are equal: none is the original, the second was simply added
 * later. Until now nothing recorded which logins belonged to whom, and the
 * deployment made up for the gap with a flag -- an account carrying `is_admin`
 * saw every mailbox in the deployment.
 *
 * That reads as "a person's own estate" only while the deployment holds one
 * person. It was the shape this fork was in, so it worked. The moment a second
 * person is given an account so they can keep their own addresses, the same
 * line hands them the first person's mail, and nothing in the stored data can
 * tell the two situations apart, because the link never existed to be read.
 *
 * What replaces it: what a person can reach is what their logins own, taken
 * together. Two people share nothing.
 */

async function signIn(email: string, password = "password123") {
	const res = await SELF.fetch("http://local.test/api/v1/auth/login", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email, password }),
	});
	return res.json<{ id: string }>();
}

function as(token: string) {
	return (url: string, options: RequestInit = {}) =>
		SELF.fetch(url, {
			...options,
			headers: { ...options.headers, Authorization: `Bearer ${token}` },
		});
}

const authStub = () => env.MAILBOX.get(env.MAILBOX.idFromName("AUTH"));

/** Registration closes behind the first account, so the rest are made here. */
async function addLogin(email: string, isAdmin: boolean, personId?: string) {
	return authStub().register(email, "password123", isAdmin, personId);
}

async function personOf(userId: string) {
	return authStub().getPersonId(userId);
}

async function mailboxesVisibleTo(token: string): Promise<string[]> {
	const res = await as(token)("http://local.test/api/v1/mailboxes");
	expect(res.status).toBe(200);
	return (await res.json<Array<{ id: string }>>()).map((m) => m.id);
}

async function makeMailbox(token: string, address: string) {
	const res = await as(token)("http://local.test/api/v1/mailboxes", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email: address, name: address }),
	});
	expect(res.status).toBe(201);
}

describe("a person with more than one login", () => {
	let firstToken: string;
	let secondToken: string;

	beforeEach(async () => {
		resetLegacyGrantMemo();

		// A registers and puts two addresses in.
		await SELF.fetch("http://local.test/api/v1/auth/register", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: "a@example.com", password: "password123" }),
		});
		const first = await signIn("a@example.com");
		firstToken = first.id;
		await makeMailbox(firstToken, "info@example.com");
		await makeMailbox(firstToken, "sales@example.com");

		// The second address A signs in with. Same person, added later.
		const person = await personOf(first.userId ?? "");
		const spare = await addLogin(
			"a-spare@example.com",
			false,
			person ?? undefined,
		);
		expect(spare.id).toBeTruthy();
		secondToken = (await signIn("a-spare@example.com")).id;
	});

	it("shows the same mailboxes through either login", async () => {
		expect((await mailboxesVisibleTo(secondToken)).sort()).toEqual([
			"info@example.com",
			"sales@example.com",
		]);
	});

	/**
	 * The point of a second login: it is not a lesser one. It was created
	 * without the administrator flag, which under the old rule meant it saw
	 * nothing at all until somebody pressed a button to raise it.
	 */
	it("does not need the administrator flag to see them", async () => {
		const res = await as(secondToken)(
			"http://local.test/api/v1/mailboxes/info@example.com",
		);
		expect(res.status).toBe(200);
	});
});

describe("two people in one deployment", () => {
	let aToken: string;
	let bToken: string;

	beforeEach(async () => {
		resetLegacyGrantMemo();

		await SELF.fetch("http://local.test/api/v1/auth/register", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: "a@example.com", password: "password123" }),
		});
		aToken = (await signIn("a@example.com")).id;
		await makeMailbox(aToken, "info@example.com");

		// B is a different person, and an administrator -- which is how the
		// old rule handed them everything.
		await addLogin("b@example.com", true);
		bToken = (await signIn("b@example.com")).id;
	});

	it("shows B nothing of A's, administrator or not", async () => {
		expect(await mailboxesVisibleTo(bToken)).toEqual([]);
		expect(
			(await as(bToken)("http://local.test/api/v1/mailboxes/info@example.com"))
				.status,
		).toBe(403);
	});

	it("still shows A their own", async () => {
		expect(await mailboxesVisibleTo(aToken)).toEqual(["info@example.com"]);
	});

	it("keeps B's own mailbox to B", async () => {
		await makeMailbox(bToken, "b-shop@example.com");
		expect(await mailboxesVisibleTo(bToken)).toEqual(["b-shop@example.com"]);
		expect(await mailboxesVisibleTo(aToken)).toEqual(["info@example.com"]);
	});
});

/**
 * A login written straight into the table without a person -- the shape every
 * row had before this column existed, and the shape a stray insert would have.
 * "Person is unset" must not match every other row whose person is also
 * unset: that would put strangers together, which is the failure this whole
 * change is about, arrived at from the other direction.
 */
describe("a login with no person recorded", () => {
	it("answers for that login alone", async () => {
		resetLegacyGrantMemo();

		await SELF.fetch("http://local.test/api/v1/auth/register", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: "a@example.com", password: "password123" }),
		});
		const aToken = (await signIn("a@example.com")).id;
		await makeMailbox(aToken, "info@example.com");

		const stub = authStub();
		await runInDurableObject(stub, async (_instance, state) => {
			const now = Date.now();
			for (const [id, email] of [
				["orphan-1", "o1@example.com"],
				["orphan-2", "o2@example.com"],
			]) {
				state.storage.sql.exec(
					"INSERT INTO users (id, email, password_hash, is_admin, person_id, created_at, updated_at) VALUES (?, ?, ?, 1, NULL, ?, ?)",
					id,
					email,
					"x",
					now,
					now,
				);
			}
			// One of them owns something; the other must not inherit it.
			state.storage.sql.exec(
				"INSERT INTO user_mailboxes (user_id, mailbox_id, role) VALUES ('orphan-1', 'info@example.com', 'owner')",
			);
		});

		expect(
			(await stub.getPersonMailboxes("orphan-1")).map((m) => m.mailboxId),
		).toEqual(["info@example.com"]);
		expect(await stub.getPersonMailboxes("orphan-2")).toEqual([]);
	});
});
