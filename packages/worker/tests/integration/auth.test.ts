import { env, runInDurableObject, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

describe("Authentication & User Management Integration Tests", () => {
	// Helper to create worker instance with auth enabled
	const createAuthWorker = async (_authConfig = { enabled: true }) => {
		// The worker will use the config from index.ts
		return SELF;
	};

	// Helper to extract session cookie from response
	const extractSessionCookie = (response: Response): string | null => {
		const setCookie = response.headers.get("Set-Cookie");
		if (!setCookie) return null;
		const match = setCookie.match(/session=([^;]+)/);
		return match ? match[1] : null;
	};

	// Helper to make authenticated request
	const authenticatedFetch = (
		url: string,
		sessionToken: string,
		options: RequestInit = {},
	) => {
		return SELF.fetch(url, {
			...options,
			headers: {
				...options.headers,
				Authorization: `Bearer ${sessionToken}`,
			},
		});
	};

	describe("Registration Flow", () => {
		it("makes the first account to register root", async () => {
			const response = await SELF.fetch(
				"http://local.test/api/v1/auth/register",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						email: "admin@example.com",
						password: "password123",
					}),
				},
			);

			expect(response.status).toBe(201);
			const body = await response.json<any>();
			expect(body).toMatchObject({
				email: "admin@example.com",
				isAdmin: true,
				// Said by the schema, as the other routes that answer with a
				// user say it; this one used to leave it out.
				role: "root",
			});
			expect(body.id).toBeDefined();
			expect(body.createdAt).toBeDefined();
		});

		it("should reject registration with weak password", async () => {
			const response = await SELF.fetch(
				"http://local.test/api/v1/auth/register",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						email: "user@example.com",
						password: "weak",
					}),
				},
			);

			expect(response.status).toBe(400);
		});

		/*
		 * This used to send the same address to the public form twice and
		 * expect "Registration is closed" -- which the form says to any second
		 * address, so it was the smart-mode test below under another name.
		 * The place a second login at a taken address can be asked for is
		 * adding a login, so that is where it is asked, in another spelling.
		 */
		it("refuses a second login at an address that already signs in", async () => {
			await SELF.fetch("http://local.test/api/v1/auth/register", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					email: "duplicate@example.com",
					password: "password123",
				}),
			});
			const login = await SELF.fetch("http://local.test/api/v1/auth/login", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					email: "duplicate@example.com",
					password: "password123",
				}),
			});
			const token = (await login.json<{ id: string }>()).id;

			const response = await authenticatedFetch(
				"http://local.test/api/v1/auth/admin/register",
				token,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						email: "Duplicate@Example.com",
						password: "password456",
						currentPassword: "password123",
					}),
				},
			);

			expect(response.status).toBe(400);
			const body = await response.json<any>();
			expect(body.error).toBe("Email already registered");
			// And the address still signs in with its own password only.
			const withNew = await SELF.fetch("http://local.test/api/v1/auth/login", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					email: "duplicate@example.com",
					password: "password456",
				}),
			});
			expect(withNew.status).toBe(401);
		});

		it("should close public registration after first user (smart mode)", async () => {
			// Register first user
			await SELF.fetch("http://local.test/api/v1/auth/register", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					email: "first@example.com",
					password: "password123",
				}),
			});

			// Try to register second user via public endpoint
			const response = await SELF.fetch(
				"http://local.test/api/v1/auth/register",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						email: "second@example.com",
						password: "password123",
					}),
				},
			);

			expect(response.status).toBe(403);
			const body = await response.json<any>();
			expect(body.error).toContain("Registration is closed");
		});
	});

	describe("Login Flow", () => {
		it("should login with valid credentials and set cookie", async () => {
			// Register user first
			await SELF.fetch("http://local.test/api/v1/auth/register", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					email: "login@example.com",
					password: "password123",
				}),
			});

			// Login
			const response = await SELF.fetch("http://local.test/api/v1/auth/login", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					email: "login@example.com",
					password: "password123",
				}),
			});

			expect(response.status).toBe(200);
			const body = await response.json<any>();
			expect(body).toMatchObject({
				email: "login@example.com",
				isAdmin: true,
			});
			expect(body.id).toBeDefined(); // session id
			expect(body.userId).toBeDefined();
			expect(body.expiresAt).toBeDefined();

			// Check cookie is set
			const setCookie = response.headers.get("Set-Cookie");
			expect(setCookie).toContain("session=");
			expect(setCookie).toContain("HttpOnly");
			expect(setCookie).toContain("Secure");
			expect(setCookie).toContain("SameSite=Strict");
		});

		it("should reject login with invalid password", async () => {
			// Register user first
			await SELF.fetch("http://local.test/api/v1/auth/register", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					email: "wrongpass@example.com",
					password: "correctpassword",
				}),
			});

			// Try to login with wrong password
			const response = await SELF.fetch("http://local.test/api/v1/auth/login", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					email: "wrongpass@example.com",
					password: "wrongpassword",
				}),
			});

			expect(response.status).toBe(401);
			const body = await response.json<any>();
			expect(body.error).toContain("Invalid credentials");
		});

		it("should reject login with non-existent email", async () => {
			const response = await SELF.fetch("http://local.test/api/v1/auth/login", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					email: "nonexistent@example.com",
					password: "password123",
				}),
			});

			expect(response.status).toBe(401);
		});
	});

	describe("Session Management", () => {
		it("should get current user with valid session", async () => {
			// Register and login
			await SELF.fetch("http://local.test/api/v1/auth/register", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					email: "session@example.com",
					password: "password123",
				}),
			});

			const loginResponse = await SELF.fetch(
				"http://local.test/api/v1/auth/login",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						email: "session@example.com",
						password: "password123",
					}),
				},
			);
			const loginBody = await loginResponse.json<any>();
			const sessionToken = loginBody.id;

			// Get current user
			const response = await authenticatedFetch(
				"http://local.test/api/v1/auth/me",
				sessionToken,
			);

			expect(response.status).toBe(200);
			const body = await response.json<any>();
			expect(body).toMatchObject({
				email: "session@example.com",
				isAdmin: true,
			});
		});

		it("should reject request with invalid session", async () => {
			const response = await authenticatedFetch(
				"http://local.test/api/v1/auth/me",
				"invalid-session-token",
			);

			expect(response.status).toBe(401);
		});

		it("should logout and invalidate session", async () => {
			// Register and login
			await SELF.fetch("http://local.test/api/v1/auth/register", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					email: "logout@example.com",
					password: "password123",
				}),
			});

			const loginResponse = await SELF.fetch(
				"http://local.test/api/v1/auth/login",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						email: "logout@example.com",
						password: "password123",
					}),
				},
			);
			const loginBody = await loginResponse.json<any>();
			const sessionToken = loginBody.id;

			// Logout
			const logoutResponse = await SELF.fetch(
				"http://local.test/api/v1/auth/logout",
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${sessionToken}`,
						Cookie: `session=${sessionToken}`,
					},
				},
			);

			expect(logoutResponse.status).toBe(200);
			const setCookie = logoutResponse.headers.get("Set-Cookie");
			expect(setCookie).toContain("Max-Age=0");

			// Try to use session after logout
			const meResponse = await authenticatedFetch(
				"http://local.test/api/v1/auth/me",
				sessionToken,
			);
			expect(meResponse.status).toBe(401);
		});
	});

	describe("Admin Operations", () => {
		let adminSessionToken: string;

		beforeEach(async () => {
			// Setup: Create admin user and get session
			await SELF.fetch("http://local.test/api/v1/auth/register", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					email: "testadmin@example.com",
					password: "adminpass123",
				}),
			});

			const loginResponse = await SELF.fetch(
				"http://local.test/api/v1/auth/login",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						email: "testadmin@example.com",
						password: "adminpass123",
					}),
				},
			);
			const loginBody = await loginResponse.json<any>();
			adminSessionToken = loginBody.id;
		});

		it("adds a login for the signed-in person, without the legacy admin flag", async () => {
			const response = await authenticatedFetch(
				"http://local.test/api/v1/auth/admin/register",
				adminSessionToken,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						email: "newuser@example.com",
						password: "password123",
						currentPassword: "adminpass123",
					}),
				},
			);

			expect(response.status).toBe(201);
			const body = await response.json<any>();
			expect(body).toMatchObject({
				email: "newuser@example.com",
				isAdmin: false, // The is_admin column is written only for the first account.
			});
		});

		it("should reject admin registration without authentication", async () => {
			const response = await SELF.fetch(
				"http://local.test/api/v1/auth/admin/register",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						email: "noauth@example.com",
						password: "password123",
						currentPassword: "adminpass123",
					}),
				},
			);

			expect(response.status).toBe(401);
		});

		it("lists the signed-in person's own logins", async () => {
			// Create additional user
			await authenticatedFetch(
				"http://local.test/api/v1/auth/admin/register",
				adminSessionToken,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						email: "listuser@example.com",
						password: "password123",
						currentPassword: "adminpass123",
					}),
				},
			);

			// List users
			const response = await authenticatedFetch(
				"http://local.test/api/v1/auth/admin/users",
				adminSessionToken,
			);

			expect(response.status).toBe(200);
			const body = await response.json<any[]>();
			expect(body.length).toBeGreaterThanOrEqual(2);
			expect(body.some((u) => u.email === "testadmin@example.com")).toBe(true);
			expect(body.some((u) => u.email === "listuser@example.com")).toBe(true);
		});

		/*
		 * Granting and revoking access to a mailbox used to be tested here,
		 * at four levels: owner, admin, write, read. The routes are gone.
		 * The levels were never read by anything -- all four stored a row and
		 * the row was the whole of the answer -- and the act itself, handing
		 * one person's mailbox to another, does not happen: an address
		 * belongs to the person who registered it.
		 */
	});

	describe("Authorization & Permissions", () => {
		/**
		 * What "admin/register" now does, seen from the account screen.
		 *
		 * The second address here is not a second person: it is another way
		 * for the same person to sign in, so both appear on their screen and
		 * both carry their role. There is no promoting to do afterwards, and
		 * no account that owns nothing waiting to be given something.
		 *
		 * That one person cannot see another's logins is asserted in
		 * own-logins.test.ts, where there are two people to tell apart.
		 */
		it("adds a login to the person who asked, not a separate account", async () => {
			// Register admin and a regular user
			await SELF.fetch("http://local.test/api/v1/auth/register", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					email: "permadmin@example.com",
					password: "password123",
				}),
			});

			const adminLoginResponse = await SELF.fetch(
				"http://local.test/api/v1/auth/login",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						email: "permadmin@example.com",
						password: "password123",
					}),
				},
			);
			const adminBody = await adminLoginResponse.json<any>();
			const adminToken = adminBody.id;

			// Admin creates regular user
			const registerResponse = await authenticatedFetch(
				"http://local.test/api/v1/auth/admin/register",
				adminToken,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						email: "regularuser@example.com",
						password: "password123",
						currentPassword: "password123",
					}),
				},
			);

			// Login as regular user
			const userLoginResponse = await SELF.fetch(
				"http://local.test/api/v1/auth/login",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						email: "regularuser@example.com",
						password: "password123",
					}),
				},
			);
			const userBody = await userLoginResponse.json<any>();
			const userToken = userBody.id;

			// The screen is no longer refused to anybody signed in -- it is
			// each person's own logins, and everybody has some. What it must
			// not do is show one person another's, which is what "admin
			// privileges required" was standing in for and doing badly: the
			// privilege was carried by half the accounts in the deployment.
			const response = await authenticatedFetch(
				"http://local.test/api/v1/auth/admin/users",
				userToken,
			);

			expect(response.status).toBe(200);
			const listed =
				await response.json<Array<{ email: string; role: string }>>();
			expect(listed.map((u) => u.email).sort()).toEqual([
				"permadmin@example.com",
				"regularuser@example.com",
			]);
			// Both are the same person, so both hold that person's role. Here
			// that person registered first and so runs the deployment: the
			// spare carries root, which is the whole of root's succession.
			// Losing one address does not lose the deployment, and nothing
			// has to be handed to anybody to make that true.
			expect(new Set(listed.map((u) => u.role))).toEqual(new Set(["root"]));
		});
	});

	describe("Security", () => {
		it("should not expose password hash in responses", async () => {
			const registerResponse = await SELF.fetch(
				"http://local.test/api/v1/auth/register",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						email: "security@example.com",
						password: "password123",
					}),
				},
			);

			const registerBody = await registerResponse.json<any>();
			expect(registerBody.password).toBeUndefined();
			expect(registerBody.password_hash).toBeUndefined();
			expect(registerBody.passwordHash).toBeUndefined();

			// Login and check session response
			const loginResponse = await SELF.fetch(
				"http://local.test/api/v1/auth/login",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						email: "security@example.com",
						password: "password123",
					}),
				},
			);

			const loginBody = await loginResponse.json<any>();
			expect(loginBody.password).toBeUndefined();
			expect(loginBody.password_hash).toBeUndefined();
			expect(loginBody.passwordHash).toBeUndefined();
		});

		/*
		 * This was called "same password should produce same hash" and
		 * checked only that signing in worked. The opposite is what should
		 * hold: the hash is salted, so the same password stored twice is two
		 * different hashes, and neither contains the password.
		 */
		it("stores a salted hash, not the password", async () => {
			await SELF.fetch("http://local.test/api/v1/auth/register", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					email: "hash@example.com",
					password: "testpassword",
				}),
			});
			const response = await SELF.fetch("http://local.test/api/v1/auth/login", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					email: "hash@example.com",
					password: "testpassword",
				}),
			});
			expect(response.status).toBe(200);
			const token = (await response.json<{ id: string }>()).id;
			// A second login with the same password.
			const added = await authenticatedFetch(
				"http://local.test/api/v1/auth/admin/register",
				token,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						email: "hash-too@example.com",
						password: "testpassword",
						currentPassword: "testpassword",
					}),
				},
			);
			expect(added.status).toBe(201);

			const hashes = await runInDurableObject(
				env.MAILBOX.get(env.MAILBOX.idFromName("AUTH")),
				async (_instance, state) =>
					state.storage.sql
						.exec(
							"SELECT password_hash FROM users WHERE email IN (?, ?)",
							"hash@example.com",
							"hash-too@example.com",
						)
						.toArray()
						.map((row) => String(row.password_hash)),
			);
			expect(hashes).toHaveLength(2);
			for (const hash of hashes) {
				expect(hash).toMatch(/^pbkdf2-sha256\$/);
				expect(hash).not.toContain("testpassword");
			}
			expect(hashes[0]).not.toBe(hashes[1]);
		});

		it("should reject requests with invalid JSON", async () => {
			const response = await SELF.fetch(
				"http://local.test/api/v1/auth/register",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: "invalid json{",
				},
			);

			expect(response.status).toBe(400);
		});
	});

	describe("Edge Cases", () => {
		it("lets only one of two registrations sent at once in", async () => {
			// Try to register two users simultaneously
			const promises = [
				SELF.fetch("http://local.test/api/v1/auth/register", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						email: "concurrent1@example.com",
						password: "password123",
					}),
				}),
				SELF.fetch("http://local.test/api/v1/auth/register", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						email: "concurrent2@example.com",
						password: "password123",
					}),
				}),
			];

			const responses = await Promise.all(promises);

			// One becomes root and the form closes behind it. "At least one
			// 201" was also true of both getting in, which is the failure.
			const statuses = responses.map((r) => r.status).sort();
			expect(statuses).toEqual([201, 403]);
		});

		it("should handle missing fields in requests", async () => {
			const response = await SELF.fetch(
				"http://local.test/api/v1/auth/register",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						email: "incomplete@example.com",
						// password missing
					}),
				},
			);

			expect(response.status).toBe(400);
		});

		it("should handle empty email or password", async () => {
			const response = await SELF.fetch(
				"http://local.test/api/v1/auth/register",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						email: "",
						password: "",
					}),
				},
			);

			expect(response.status).toBe(400);
		});
	});
});
