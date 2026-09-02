import { env, runInDurableObject, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../../src/password";
import { authenticatedFetch, testAuthBeforeAll } from "./utils";

const EMAIL = "owner@example.com";
const PASSWORD = "correct-horse-battery-staple";

function authStub() {
	// @ts-expect-error test binding
	return env.MAILBOX.get(env.MAILBOX.idFromName("AUTH"));
}

async function seedUser(passwordHash: string) {
	await runInDurableObject(authStub(), async (_instance, state) => {
		const now = Date.now();
		state.storage.sql.exec(
			"INSERT OR REPLACE INTO users (id, email, password_hash, is_admin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			"owner-1",
			EMAIL,
			passwordHash,
			0,
			now,
			now,
		);
	});
}

async function storedHash(): Promise<string> {
	return await runInDurableObject(authStub(), async (_instance, state) => {
		const rows = state.storage.sql
			.exec("SELECT password_hash FROM users WHERE email = ?", EMAIL)
			.toArray();
		return String(rows[0].password_hash);
	});
}

async function legacyHash(password: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(password),
	);
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

const login = (password: string, email = EMAIL) =>
	SELF.fetch("http://local.test/api/v1/auth/login", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email, password }),
	});

const forgotPassword = (email: string) =>
	SELF.fetch("http://local.test/api/v1/auth/forgot-password", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email }),
	});

describe("Login is rate limited", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await seedUser(await hashPassword(PASSWORD));
	});

	it("locks the address out once the failure limit is reached", async () => {
		for (let attempt = 1; attempt <= 10; attempt++) {
			const res = await login("wrong-password");
			expect(res.status, `attempt ${attempt}`).toBe(401);
		}

		const locked = await login("wrong-password");
		expect(locked.status).toBe(429);
		expect(Number(locked.headers.get("Retry-After"))).toBeGreaterThan(0);
	});

	// Without the lock, the right password would still be accepted while an
	// attacker kept guessing. It must not be: that is the whole protection.
	it("refuses the correct password too while the lock is in force", async () => {
		for (let attempt = 1; attempt <= 10; attempt++) {
			await login("wrong-password");
		}

		const res = await login(PASSWORD);
		expect(res.status).toBe(429);
	});

	it("forgets earlier failures once the password is right", async () => {
		for (let attempt = 1; attempt <= 9; attempt++) {
			expect((await login("wrong-password")).status).toBe(401);
		}

		expect((await login(PASSWORD)).status).toBe(200);

		// Nine more would total eighteen and be well past the limit if the
		// counter had survived the successful login.
		for (let attempt = 1; attempt <= 9; attempt++) {
			expect((await login("wrong-password")).status).toBe(401);
		}
	});

	it("counts attempts against addresses that have no account at all", async () => {
		for (let attempt = 1; attempt <= 10; attempt++) {
			expect((await login("x", "ghost@example.com")).status).toBe(401);
		}
		expect((await login("x", "ghost@example.com")).status).toBe(429);
	});
});

describe("Legacy password hashes", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
	});

	it("upgrades to PBKDF2 on the next successful login", async () => {
		await seedUser(await legacyHash(PASSWORD));
		expect(await storedHash()).toMatch(/^[0-9a-f]{64}$/);

		expect((await login(PASSWORD)).status).toBe(200);

		expect(await storedHash()).toMatch(/^pbkdf2-sha256\$/);
		// The rewritten hash has to be usable, not merely present.
		expect((await login(PASSWORD)).status).toBe(200);
	});

	it("leaves the stored hash alone when the password was wrong", async () => {
		const legacy = await legacyHash(PASSWORD);
		await seedUser(legacy);

		expect((await login("wrong-password")).status).toBe(401);
		expect(await storedHash()).toBe(legacy);
	});
});

describe("Password reset does not say which addresses exist", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await seedUser(await hashPassword(PASSWORD));
	});

	it("answers a known and an unknown address identically", async () => {
		const known = await forgotPassword(EMAIL);
		const unknown = await forgotPassword("nobody@example.com");

		expect(known.status).toBe(unknown.status);
		expect(known.status).toBe(200);
		expect(await known.json()).toEqual(await unknown.json());
	});

	it("rate limits repeated requests for the same address", async () => {
		for (let attempt = 1; attempt <= 3; attempt++) {
			expect((await forgotPassword(EMAIL)).status).toBe(200);
		}

		const limited = await forgotPassword(EMAIL);
		expect(limited.status).toBe(429);
		expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
	});

	// The limit has to apply to addresses with no account too, or the rate at
	// which requests are accepted answers the question the response no longer
	// does.
	it("rate limits an unknown address just the same", async () => {
		for (let attempt = 1; attempt <= 3; attempt++) {
			expect((await forgotPassword("nobody@example.com")).status).toBe(200);
		}
		expect((await forgotPassword("nobody@example.com")).status).toBe(429);
	});
});

describe("Route authorisation", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
	});

	it("keeps the API documentation behind a session", async () => {
		expect((await SELF.fetch("http://local.test/openapi.json")).status).toBe(
			401,
		);
		expect((await SELF.fetch("http://local.test/docs")).status).toBe(401);

		const authed = await authenticatedFetch("http://local.test/openapi.json");
		expect(authed.status).toBe(200);
	});

	// The allowlist used to match by prefix, which quietly made every path
	// starting with a public one public as well.
	it("matches the public allowlist exactly, not by prefix", async () => {
		expect((await SELF.fetch("http://local.test/api/v1/settings")).status).toBe(
			200,
		);
		expect(
			(await SELF.fetch("http://local.test/api/v1/settings-and-secrets"))
				.status,
		).toBe(401);
		expect(
			(await SELF.fetch("http://local.test/api/v1/auth/login-as-anyone"))
				.status,
		).toBe(401);
	});

	it("no longer exposes the debug mailbox fixture", async () => {
		const res = await authenticatedFetch(
			"http://local.test/api/v1/debug/create-mailbox",
			{ method: "POST" },
		);
		expect(res.status).toBe(404);
	});
});
