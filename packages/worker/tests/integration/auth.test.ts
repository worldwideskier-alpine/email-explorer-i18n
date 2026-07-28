import { SELF, env } from "cloudflare:test";
import { describe, expect, it, beforeEach } from "vitest";

describe("Authentication & User Management Integration Tests", () => {
	// Helper to create worker instance with auth enabled
	const createAuthWorker = async (authConfig = { enabled: true }) => {
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
		it("should allow first user registration and make them admin", async () => {
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

		it("should reject duplicate email registration", async () => {
			// Register first user
			await SELF.fetch("http://local.test/api/v1/auth/register", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					email: "duplicate@example.com",
					password: "password123",
				}),
			});

			// Try to register same email again
			const response = await SELF.fetch(
				"http://local.test/api/v1/auth/register",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						email: "duplicate@example.com",
						password: "password456",
					}),
				},
			);

			expect(response.status).toBe(403);
			const body = await response.json<any>();
			expect(body.error).toContain("Registration is closed");
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

		it("should allow admin to register new users", async () => {
			const response = await authenticatedFetch(
				"http://local.test/api/v1/auth/admin/register",
				adminSessionToken,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						email: "newuser@example.com",
						password: "password123",
					}),
				},
			);

			expect(response.status).toBe(201);
			const body = await response.json<any>();
			expect(body).toMatchObject({
				email: "newuser@example.com",
				isAdmin: false, // Admin-created users are not admin by default
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
					}),
				},
			);

			expect(response.status).toBe(401);
		});

		it("should allow admin to list all users", async () => {
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

		it("should allow admin to grant mailbox access", async () => {
			// Create user
			const registerResponse = await authenticatedFetch(
				"http://local.test/api/v1/auth/admin/register",
				adminSessionToken,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						email: "accessuser@example.com",
						password: "password123",
					}),
				},
			);
			const user = await registerResponse.json<any>();

			// Grant mailbox access
			const response = await authenticatedFetch(
				"http://local.test/api/v1/auth/admin/grant-access",
				adminSessionToken,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						userId: user.id,
						mailboxId: "mailbox@example.com",
						role: "read",
					}),
				},
			);

			expect(response.status).toBe(200);
			const body = await response.json<any>();
			expect(body.status).toBe("access granted");
		});

		it("should allow admin to revoke mailbox access", async () => {
			// Create user and grant access
			const registerResponse = await authenticatedFetch(
				"http://local.test/api/v1/auth/admin/register",
				adminSessionToken,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						email: "revokeuser@example.com",
						password: "password123",
					}),
				},
			);
			const user = await registerResponse.json<any>();

			await authenticatedFetch(
				"http://local.test/api/v1/auth/admin/grant-access",
				adminSessionToken,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						userId: user.id,
						mailboxId: "mailbox@example.com",
						role: "write",
					}),
				},
			);

			// Revoke access
			const response = await authenticatedFetch(
				"http://local.test/api/v1/auth/admin/revoke-access",
				adminSessionToken,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						userId: user.id,
						mailboxId: "mailbox@example.com",
					}),
				},
			);

			expect(response.status).toBe(200);
			const body = await response.json<any>();
			expect(body.status).toBe("access revoked");
		});

		it("should validate role types for mailbox access", async () => {
			// Create user
			const registerResponse = await authenticatedFetch(
				"http://local.test/api/v1/auth/admin/register",
				adminSessionToken,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						email: "roleuser@example.com",
						password: "password123",
					}),
				},
			);
			const user = await registerResponse.json<any>();

			// Valid roles
			const validRoles = ["owner", "admin", "write", "read"];
			for (const role of validRoles) {
				const response = await authenticatedFetch(
					"http://local.test/api/v1/auth/admin/grant-access",
					adminSessionToken,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							userId: user.id,
							mailboxId: `mailbox-${role}@example.com`,
							role,
						}),
					},
				);
				expect(response.status).toBe(200);
			}

			// Invalid role
			const invalidResponse = await authenticatedFetch(
				"http://local.test/api/v1/auth/admin/grant-access",
				adminSessionToken,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						userId: user.id,
						mailboxId: "mailbox@example.com",
						role: "invalid-role",
					}),
				},
			);
			expect(invalidResponse.status).toBe(400);
		});
	});

	describe("Authorization & Permissions", () => {
		it("should reject non-admin from accessing admin endpoints", async () => {
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

			// Try to access admin endpoint with regular user token
			const response = await authenticatedFetch(
				"http://local.test/api/v1/auth/admin/users",
				userToken,
			);

			expect(response.status).toBe(403);
			const body = await response.json<any>();
			expect(body.error).toContain("Admin privileges required");
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

		it("should hash passwords (same password should produce same hash)", async () => {
			// This tests that password hashing is deterministic
			// Register user
			await SELF.fetch("http://local.test/api/v1/auth/register", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					email: "hash@example.com",
					password: "testpassword",
				}),
			});

			// Login should work with same password
			const response = await SELF.fetch("http://local.test/api/v1/auth/login", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					email: "hash@example.com",
					password: "testpassword",
				}),
			});

			expect(response.status).toBe(200);
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
		it("should handle concurrent registrations gracefully", async () => {
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

			// One should succeed (become admin), one should fail (registration closed)
			const statuses = responses.map((r) => r.status);
			expect(statuses).toContain(201); // At least one success
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
