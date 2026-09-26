import { env, runInDurableObject, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../../src/password";

/**
 * Limits and firsts that have to hold when requests arrive together.
 *
 * A Durable Object runs other requests while one awaits, so anything decided
 * in one call and acted on in the next is decided for every request that
 * arrived in between. Each case here was measured going wrong that way: a
 * burst of guesses all verified before any was counted, and two
 * registrations to a new deployment both told they were the first.
 */

const API = "http://local.test/api/v1";
const EMAIL = "owner@example.com";
const PASSWORD = "correct-horse-battery-staple";

function authStub() {
	// @ts-expect-error test binding
	return env.MAILBOX.get(env.MAILBOX.idFromName("AUTH"));
}

async function seedOwner() {
	const hash = await hashPassword(PASSWORD);
	await runInDurableObject(authStub(), async (_i, state) => {
		const now = Date.now();
		state.storage.sql.exec(
			"INSERT INTO users (id, email, password_hash, is_admin, person_id, created_at, updated_at) VALUES ('owner', ?, ?, 0, 'person-owner', ?, ?)",
			EMAIL,
			hash,
			now,
			now,
		);
		state.storage.sql.exec(
			"INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES ('owner-session', 'owner', ?, ?)",
			now + 24 * 60 * 60 * 1000,
			now,
		);
	});
}

const post = (path: string, body: unknown, token?: string) =>
	SELF.fetch(`${API}${path}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
		body: JSON.stringify(body),
	});

const login = (password: string, email = EMAIL) =>
	post("/auth/login", { email, password });

const tally = (statuses: number[]) =>
	statuses.reduce<Record<number, number>>((acc, s) => {
		acc[s] = (acc[s] ?? 0) + 1;
		return acc;
	}, {});

describe("the login limit under a burst", () => {
	beforeEach(seedOwner);

	it("verifies no more guesses than the limit, however many arrive at once", async () => {
		const responses = await Promise.all(
			Array.from({ length: 25 }, () => login("wrong-password")),
		);
		expect(tally(responses.map((r) => r.status))).toEqual({
			401: 10,
			429: 15,
		});
	});
});

/**
 * The per-IP key is shared by every account behind that address, so a
 * success on one account must not wipe the count of guesses at others --
 * whoever holds one working account could otherwise log into it between
 * batches and guess without limit. It gets back only its own attempt.
 */
describe("the per-IP limit and a successful login", () => {
	beforeEach(seedOwner);

	it("does not forget guesses at other addresses", async () => {
		for (let i = 1; i <= 29; i++) {
			expect((await login("x", `guess-${i}@example.com`)).status).toBe(401);
		}
		expect((await login(PASSWORD)).status).toBe(200);

		expect((await login("x", "guess-30@example.com")).status).toBe(401);
		expect((await login("x", "guess-31@example.com")).status).toBe(429);
	});

	it("is not used up by successes", async () => {
		for (let i = 1; i <= 35; i++) {
			expect((await login(PASSWORD)).status, `login ${i}`).toBe(200);
		}
		expect((await login("x", "guess@example.com")).status).toBe(401);
	});
});

/**
 * A confirmation mail sent is the thing this limit is for, so a successful
 * request stays counted. It used to reset the count after every send.
 */
describe("the address-change limit", () => {
	beforeEach(seedOwner);

	it("counts every confirmation mail sent", async () => {
		for (let i = 1; i <= 10; i++) {
			const res = await post(
				"/auth/change-email",
				{ currentPassword: PASSWORD, newEmail: `new-${i}@example.net` },
				"owner-session",
			);
			expect(res.status, `send ${i}`).toBe(200);
		}
		const eleventh = await post(
			"/auth/change-email",
			{ currentPassword: PASSWORD, newEmail: "new-11@example.net" },
			"owner-session",
		);
		expect(eleventh.status).toBe(429);
	});
});

describe("the first registration", () => {
	it("is one account, however many arrive at once", async () => {
		const responses = await Promise.all(
			["a", "b", "c", "d"].map((who) =>
				post("/auth/register", {
					email: `${who}@example.com`,
					password: "password123",
				}),
			),
		);
		expect(tally(responses.map((r) => r.status))).toEqual({ 201: 1, 403: 3 });

		const state = await runInDurableObject(authStub(), async (_i, s) => ({
			users: s.storage.sql
				.exec("SELECT person_id, is_admin FROM users")
				.toArray(),
			root: s.storage.sql
				.exec("SELECT root_person_id FROM app_roles WHERE id = 1")
				.one().root_person_id,
		}));
		expect(state.users).toHaveLength(1);
		expect(state.users[0].is_admin).toBe(1);
		expect(state.root).toBe(state.users[0].person_id);
	});
});
