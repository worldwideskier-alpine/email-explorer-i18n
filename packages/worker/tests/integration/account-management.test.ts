import { env, runInDurableObject, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../../src/password";
import { authenticatedFetch, sessionToken, testAuthBeforeAll } from "./utils";

const EMAIL = "owner@example.com";
const PASSWORD = "correct-horse-battery-staple";
const OTHER_SESSION = "another-device-session";

function authStub() {
	// @ts-expect-error test binding
	return env.MAILBOX.get(env.MAILBOX.idFromName("AUTH"));
}

/**
 * testAuthBeforeAll seeds a session whose user has an unusable password hash,
 * which is fine for routes that only need a session. These tests sign that
 * same user in and out, so it needs a real address and a real hash.
 */
async function seedOwner(isAdmin = 1) {
	const hash = await hashPassword(PASSWORD);
	await runInDurableObject(authStub(), async (_instance, state) => {
		const now = Date.now();
		state.storage.sql.exec(
			"UPDATE users SET email = ?, password_hash = ?, is_admin = ? WHERE id = 'user1'",
			EMAIL,
			hash,
			isAdmin,
		);
		// A second, still-valid session for the same user, standing in for
		// another browser or phone that is signed in.
		state.storage.sql.exec(
			"INSERT OR REPLACE INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
			OTHER_SESSION,
			"user1",
			now + 30 * 24 * 60 * 60 * 1000,
			now,
		);
	});
}

async function sessionIds(): Promise<string[]> {
	return await runInDurableObject(authStub(), async (_i, state) =>
		state.storage.sql
			.exec("SELECT id FROM sessions WHERE user_id = 'user1'")
			.toArray()
			.map((r) => String(r.id)),
	);
}

async function storedEmail(): Promise<string> {
	return await runInDurableObject(authStub(), async (_i, state) =>
		String(
			state.storage.sql
				.exec("SELECT email FROM users WHERE id = 'user1'")
				.toArray()[0].email,
		),
	);
}

const post = (path: string, body: unknown) =>
	authenticatedFetch(`http://local.test${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});

/*
 * There is no "administrator rights" block any more, and no route for one.
 *
 * Promoting and demoting existed because the account screen could make an
 * account that owned nothing, which then had to be raised by hand. Both ends
 * of that are gone: the screen adds another login to the person using it, so
 * what it makes is already theirs and already carries their role. Nothing
 * grants a role to anybody, so nothing can remove one either -- and the
 * "cannot remove the last administrator" guard has nothing left to guard.
 */

describe("Changing your own password", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await seedOwner();
	});

	// 403 rather than 401 on purpose. The dashboard signs the user out on any
	// 401, so answering one for a mistyped current password would throw them
	// out of the session they are sitting in.
	it("refuses a wrong current password with 403, not 401", async () => {
		const res = await post("/api/v1/auth/change-password", {
			currentPassword: "not-the-password",
			newPassword: "a-brand-new-password",
		});
		expect(res.status).toBe(403);
	});

	it("changes the password and lets the new one sign in", async () => {
		const res = await post("/api/v1/auth/change-password", {
			currentPassword: PASSWORD,
			newPassword: "a-brand-new-password",
		});
		expect(res.status).toBe(200);

		const login = await SELF.fetch("http://local.test/api/v1/auth/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: EMAIL, password: "a-brand-new-password" }),
		});
		expect(login.status).toBe(200);
	});

	// Changing a password because somebody else has it is pointless if the
	// session they are already holding survives the change.
	it("signs out every other session but keeps the current one", async () => {
		expect(await sessionIds()).toContain(OTHER_SESSION);

		await post("/api/v1/auth/change-password", {
			currentPassword: PASSWORD,
			newPassword: "a-brand-new-password",
		});

		const remaining = await sessionIds();
		expect(remaining).toContain(sessionToken);
		expect(remaining).not.toContain(OTHER_SESSION);
	});

	it("rejects a new password shorter than the minimum", async () => {
		const res = await post("/api/v1/auth/change-password", {
			currentPassword: PASSWORD,
			newPassword: "short",
		});
		expect(res.status).toBe(400);
	});
});

describe("Changing your sign-in address", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await seedOwner();
	});

	it("refuses a wrong current password with 403, not 401", async () => {
		const res = await post("/api/v1/auth/change-email", {
			currentPassword: "not-the-password",
			newEmail: "elsewhere@example.net",
		});
		expect(res.status).toBe(403);
		expect(await storedEmail()).toBe(EMAIL);
	});

	// The whole point is proving the new address can be read, so nothing may
	// change until somebody follows the link that was sent to it.
	it("does not change anything until the link is followed", async () => {
		const res = await post("/api/v1/auth/change-email", {
			currentPassword: PASSWORD,
			newEmail: "elsewhere@example.net",
		});
		expect(res.status).toBe(200);
		expect(await storedEmail()).toBe(EMAIL);
	});

	it("applies the change when the emailed token is presented", async () => {
		await post("/api/v1/auth/change-email", {
			currentPassword: PASSWORD,
			newEmail: "elsewhere@example.net",
		});

		// @ts-expect-error test binding
		const listed = await env.BUCKET.list({ prefix: "email-change-tokens/" });
		expect(listed.objects).toHaveLength(1);
		const token = listed.objects[0].key
			.replace("email-change-tokens/", "")
			.replace(".json", "");

		const confirm = await SELF.fetch(
			"http://local.test/api/v1/auth/confirm-email-change",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ token }),
			},
		);
		expect(confirm.status).toBe(200);
		expect(await storedEmail()).toBe("elsewhere@example.net");

		// Single use: the token is gone once it has been spent.
		// @ts-expect-error test binding
		const after = await env.BUCKET.list({ prefix: "email-change-tokens/" });
		expect(after.objects).toHaveLength(0);
	});

	it("refuses an unknown token", async () => {
		const res = await SELF.fetch(
			"http://local.test/api/v1/auth/confirm-email-change",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ token: crypto.randomUUID() }),
			},
		);
		expect(res.status).toBe(401);
	});

	it("refuses an address that already has an account", async () => {
		await runInDurableObject(authStub(), async (_i, state) => {
			const now = Date.now();
			state.storage.sql.exec(
				"INSERT OR REPLACE INTO users (id, email, password_hash, is_admin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
				"user2",
				"taken@example.net",
				"x",
				0,
				now,
				now,
			);
		});

		const res = await post("/api/v1/auth/change-email", {
			currentPassword: PASSWORD,
			newEmail: "taken@example.net",
		});
		expect(res.status).toBe(409);
	});
});
