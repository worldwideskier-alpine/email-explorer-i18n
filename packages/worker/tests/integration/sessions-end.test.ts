import { env, runInDurableObject, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../../src/password";

/**
 * What ending a session takes with it.
 *
 * A password is changed or reset because somebody else may know it, so
 * whatever that somebody is holding has to stop working: their session, and
 * the push subscription their browser registered, which is told the sender
 * and subject of every new message. Signing out ends the one session and its
 * subscription; a session that expires stops being delivered to.
 */

const EMAIL = "owner@example.com";
const PASSWORD = "correct-horse-battery-staple";
const API = "http://local.test/api/v1";
const DAY = 24 * 60 * 60 * 1000;

function authStub() {
	// @ts-expect-error test binding
	return env.MAILBOX.get(env.MAILBOX.idFromName("AUTH"));
}

async function seedOwnerWithSessions(sessions: Record<string, number>) {
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
		for (const [id, expiresAt] of Object.entries(sessions)) {
			state.storage.sql.exec(
				"INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, 'owner', ?, ?)",
				id,
				expiresAt,
				now,
			);
		}
	});
}

const as = (token: string, path: string, body?: unknown) =>
	SELF.fetch(`${API}${path}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});

const subscribe = (token: string, device: string) =>
	as(token, "/push/subscribe", {
		endpoint: `https://push.example.net/${device}`,
		keys: { p256dh: `p256dh-${device}`, auth: `auth-${device}` },
	});

/** The endpoints a new message for the owner would be pushed to. */
async function deliveredTo(): Promise<string[]> {
	const subs = await authStub().getPushSubscriptionsForUsers(["owner"]);
	return subs
		.map((s: { endpoint: string }) => s.endpoint.split("/").pop())
		.sort();
}

async function liveSessions(): Promise<string[]> {
	return await runInDurableObject(authStub(), async (_i, state) =>
		state.storage.sql
			.exec("SELECT id FROM sessions WHERE user_id = 'owner' ORDER BY id")
			.toArray()
			.map((r) => String(r.id)),
	);
}

async function resetWithToken(newPassword: string) {
	const token = crypto.randomUUID();
	// @ts-expect-error test binding
	await env.BUCKET.put(
		`recovery-tokens/${token}.json`,
		JSON.stringify({
			userId: "owner",
			email: EMAIL,
			expiresAt: Date.now() + 60_000,
		}),
	);
	return SELF.fetch(`${API}/auth/reset-password`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ token, newPassword }),
	});
}

describe("a password reset", () => {
	beforeEach(async () => {
		await seedOwnerWithSessions({
			mine: Date.now() + DAY,
			theirs: Date.now() + DAY,
		});
	});

	it("ends every session and every push subscription, and the new password works", async () => {
		expect((await subscribe("mine", "phone")).status).toBe(200);
		expect((await subscribe("theirs", "laptop")).status).toBe(200);
		expect(await deliveredTo()).toEqual(["laptop", "phone"]);

		expect((await resetWithToken("a-brand-new-password")).status).toBe(200);

		expect(await liveSessions()).toEqual([]);
		expect(await deliveredTo()).toEqual([]);
		expect(
			(
				await SELF.fetch(`${API}/auth/me`, {
					headers: { Authorization: "Bearer theirs" },
				})
			).status,
		).toBe(401);

		const login = await SELF.fetch(`${API}/auth/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: EMAIL, password: "a-brand-new-password" }),
		});
		expect(login.status).toBe(200);
	});

	it("works once", async () => {
		const token = crypto.randomUUID();
		// @ts-expect-error test binding
		await env.BUCKET.put(
			`recovery-tokens/${token}.json`,
			JSON.stringify({
				userId: "owner",
				email: EMAIL,
				expiresAt: Date.now() + 60_000,
			}),
		);
		const reset = (newPassword: string) =>
			SELF.fetch(`${API}/auth/reset-password`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ token, newPassword }),
			});
		expect((await reset("first-new-password")).status).toBe(200);
		expect((await reset("second-new-password")).status).toBe(401);
	});

	it("refuses an expired link and changes nothing", async () => {
		const token = crypto.randomUUID();
		// @ts-expect-error test binding
		await env.BUCKET.put(
			`recovery-tokens/${token}.json`,
			JSON.stringify({
				userId: "owner",
				email: EMAIL,
				expiresAt: Date.now() - 1,
			}),
		);
		const res = await SELF.fetch(`${API}/auth/reset-password`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token, newPassword: "never-applied-password" }),
		});
		expect(res.status).toBe(401);
		expect(await liveSessions()).toEqual(["mine", "theirs"]);
	});
});

describe("changing the password", () => {
	beforeEach(async () => {
		await seedOwnerWithSessions({
			mine: Date.now() + DAY,
			theirs: Date.now() + DAY,
		});
	});

	it("keeps this session's subscription and ends the others'", async () => {
		await subscribe("mine", "phone");
		await subscribe("theirs", "laptop");

		const changed = await as("mine", "/auth/change-password", {
			currentPassword: PASSWORD,
			newPassword: "a-brand-new-password",
		});
		expect(changed.status).toBe(200);

		expect(await liveSessions()).toEqual(["mine"]);
		expect(await deliveredTo()).toEqual(["phone"]);
	});

	/**
	 * A subscription saved before subscriptions recorded their session is
	 * delivered to until something ends the account's other sessions -- then
	 * nothing says it is the kept session's, so it goes.
	 */
	it("removes a subscription that records no session", async () => {
		await runInDurableObject(authStub(), async (_i, state) => {
			state.storage.sql.exec(
				"INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at) VALUES ('old', 'owner', 'https://push.example.net/old', 'k', 'a', 0)",
			);
		});
		expect(await deliveredTo()).toEqual(["old"]);

		await as("mine", "/auth/change-password", {
			currentPassword: PASSWORD,
			newPassword: "a-brand-new-password",
		});
		expect(await deliveredTo()).toEqual([]);
	});
});

describe("a session ending by itself", () => {
	it("signing out stops that browser's notifications and nobody else's", async () => {
		await seedOwnerWithSessions({
			mine: Date.now() + DAY,
			theirs: Date.now() + DAY,
		});
		await subscribe("mine", "phone");
		await subscribe("theirs", "laptop");

		expect((await as("theirs", "/auth/logout")).status).toBe(200);
		expect(await deliveredTo()).toEqual(["phone"]);
	});

	it("an expired session is not delivered to", async () => {
		await seedOwnerWithSessions({ mine: Date.now() + DAY });
		await subscribe("mine", "phone");
		await runInDurableObject(authStub(), async (_i, state) => {
			state.storage.sql.exec(
				"UPDATE sessions SET expires_at = ? WHERE id = 'mine'",
				Date.now() - 1,
			);
		});
		expect(await deliveredTo()).toEqual([]);
	});

	it("subscribing again from a new session brings the browser back", async () => {
		await seedOwnerWithSessions({
			mine: Date.now() + DAY,
			later: Date.now() + DAY,
		});
		await subscribe("mine", "phone");
		await as("mine", "/auth/logout");
		expect(await deliveredTo()).toEqual([]);

		await subscribe("later", "phone");
		expect(await deliveredTo()).toEqual(["phone"]);
	});
});

describe("unsubscribing", () => {
	it("removes only the caller's own subscription", async () => {
		await seedOwnerWithSessions({ mine: Date.now() + DAY });
		await subscribe("mine", "phone");
		await runInDurableObject(authStub(), async (_i, state) => {
			const now = Date.now();
			state.storage.sql.exec(
				"INSERT INTO users (id, email, password_hash, is_admin, person_id, created_at, updated_at) VALUES ('other', 'other@example.com', 'x', 0, 'person-other', ?, ?)",
				now,
				now,
			);
			state.storage.sql.exec(
				"INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES ('other-session', 'other', ?, ?)",
				now + DAY,
				now,
			);
		});

		const res = await as("other-session", "/push/unsubscribe", {
			endpoint: "https://push.example.net/phone",
		});
		expect(res.status).toBe(200);
		expect(await deliveredTo()).toEqual(["phone"]);

		await as("mine", "/push/unsubscribe", {
			endpoint: "https://push.example.net/phone",
		});
		expect(await deliveredTo()).toEqual([]);
	});
});
