import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What signing in actually leaves behind.
 *
 * Every other test about the legacy admin flag reads source text, and source
 * text was not where it survived. The store used to sign in with
 * `session.value = response.data` -- the whole login response, and the Worker's
 * login response still carries `isAdmin`. So the flag went on living in the
 * reactive session and in localStorage no matter what the file said, and a
 * `Session` type without the field only meant a cast would reach a real value
 * rather than undefined. A test that greps for the name cannot see any of that.
 *
 * So this one signs in and looks.
 */

const loginResponse = {
	id: "session-1",
	userId: "user-1",
	email: "someone@example.com",
	role: "admin" as const,
	expiresAt: Date.now() + 60_000,
	// The Worker still sends it. That is the point: nothing here may keep it.
	isAdmin: true,
};

vi.mock("@/services/api", () => ({
	default: {
		login: vi.fn(async () => ({ data: loginResponse })),
		setAuthToken: vi.fn(),
		getCurrentUser: vi.fn(async () => ({
			data: {
				id: "user-1",
				email: "someone@example.com",
				role: "admin",
				isAdmin: true,
			},
		})),
		logout: vi.fn(async () => ({ data: {} })),
	},
}));

const { useAuthStore } = await import("./auth");

describe("the session a sign-in leaves behind", () => {
	beforeEach(() => {
		setActivePinia(createPinia());
		localStorage.clear();
	});

	it("does not keep the legacy admin flag in memory", async () => {
		const auth = useAuthStore();
		await auth.login("someone@example.com", "password");

		expect(auth.session).not.toBeNull();
		expect(Object.keys(auth.session ?? {})).not.toContain("isAdmin");
	});

	it("does not keep it in localStorage either", async () => {
		const auth = useAuthStore();
		await auth.login("someone@example.com", "password");

		const stored = localStorage.getItem("session");
		expect(stored).toBeTruthy();
		expect(Object.keys(JSON.parse(stored ?? "{}"))).not.toContain("isAdmin");
	});

	// And it keeps what the rest of the dashboard needs, so "drop the field"
	// has not quietly become "drop the session".
	it("keeps what the screens actually read", async () => {
		const auth = useAuthStore();
		await auth.login("someone@example.com", "password");

		expect(auth.session?.id).toBe("session-1");
		expect(auth.session?.userId).toBe("user-1");
		expect(auth.session?.email).toBe("someone@example.com");
		expect(auth.session?.expiresAt).toBe(loginResponse.expiresAt);
		expect(auth.role).toBe("admin");
		expect(auth.isRoot).toBe(false);
	});

	/**
	 * Refreshing the session is the other way the field could come back: it
	 * merges a fresh reply into what is already stored.
	 */
	it("does not let a refresh put it back", async () => {
		const auth = useAuthStore();
		await auth.login("someone@example.com", "password");
		await auth.checkAuth();

		expect(Object.keys(auth.session ?? {})).not.toContain("isAdmin");
		expect(
			Object.keys(JSON.parse(localStorage.getItem("session") ?? "{}")),
		).not.toContain("isAdmin");
	});
});
