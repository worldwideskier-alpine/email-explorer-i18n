import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Where the router's guard sends each kind of visitor, and that it says so
 * by returning a destination. vue-router 5 deprecates the `next` callback
 * and prints VUE_ROUTER_R0025 on every navigation that used it.
 */

let role = "admin";
vi.mock("@/services/api", () => ({
	default: {
		getCurrentUser: vi.fn(async () => ({
			data: { id: "u", email: `${role}@example.com`, role },
		})),
		setAuthToken: vi.fn(),
		clearAuthToken: vi.fn(),
		logout: vi.fn(async () => ({})),
	},
}));

const printed: string[] = [];

beforeEach(() => {
	vi.resetModules();
	setActivePinia(createPinia());
	localStorage.clear();
	printed.length = 0;
	for (const level of ["warn", "error", "log", "info"] as const) {
		vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
			printed.push(args.map(String).join(" "));
		});
	}
});

afterEach(() => {
	vi.restoreAllMocks();
});

function signIn(as: string) {
	role = as;
	localStorage.setItem(
		"session",
		JSON.stringify({
			id: "s",
			userId: "u",
			email: `${as}@example.com`,
			role: as,
			expiresAt: Date.now() + 60_000,
		}),
	);
}

async function visits(pairs: [string, string][]) {
	const { default: router } = await import("@/router");
	for (const [path, name] of pairs) {
		await router.push(path);
		expect(router.currentRoute.value.name, path).toBe(name);
	}
	return router;
}

describe("the router's guard", () => {
	it("sends somebody signed out to sign in, and remembers where to", async () => {
		const router = await visits([
			["/mailbox/x%40example.com/emails/inbox", "Login"],
			["/forgot-password", "ForgotPassword"],
		]);
		await router.push("/account");
		expect(router.currentRoute.value.query.redirect).toBe("/account");
	});

	it("keeps an administrator off root's screen and off sign-in", async () => {
		signIn("admin");
		await visits([
			["/root", "Home"],
			["/login", "Home"],
			["/account", "Account"],
			["/mailbox/x%40example.com/emails/inbox", "EmailList"],
		]);
	});

	it("keeps root on its own screens", async () => {
		signIn("root");
		await visits([
			["/", "Root"],
			["/admin", "Root"],
			["/register", "Root"],
			["/account", "Account"],
		]);
	});

	it("does it without the deprecated callback", async () => {
		signIn("admin");
		await visits([
			["/root", "Home"],
			["/account", "Account"],
		]);
		expect(printed.filter((line) => line.includes("R0025"))).toEqual([]);
	});
});
