import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Where the router's guard sends each kind of visitor, and that it says so
 * by returning a destination. vue-router 5 deprecates the `next` callback
 * and prints VUE_ROUTER_R0025 on every navigation that used it.
 */

let role = "admin";
/** What /auth/me answers: the session is good, or it is gone (401). */
let me: "good" | "gone" = "good";
/** The sign-outs the guard sent, which an automatic end must not. */
let signOutsSent = 0;
vi.mock("@/services/api", () => ({
	default: {
		getCurrentUser: vi.fn(async () => {
			if (me === "gone") {
				throw Object.assign(new Error("401"), { response: { status: 401 } });
			}
			return { data: { id: "u", email: `${role}@example.com`, role } };
		}),
		setAuthToken: vi.fn(),
		clearAuthToken: vi.fn(),
		logout: vi.fn(async () => {
			signOutsSent++;
			return {};
		}),
	},
}));

const printed: string[] = [];

beforeEach(() => {
	me = "good";
	signOutsSent = 0;
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

/**
 * A tab kept open past its session's time. The session is asked about once
 * per page, so it is this branch of the guard that meets it -- at the next
 * navigation, a tap on the "open the app" notification among them. It used
 * to sign out: ending the session on the server deleted the row the Worker
 * tells a lapsed device through, and the browser let go of its own, which
 * is the silence this was written against. And it went by this device's
 * clock, so one running ahead ended a session the server still held.
 */
describe("a session whose time has passed by this device's clock", () => {
	afterEach(() => {
		Reflect.deleteProperty(navigator, "serviceWorker");
		vi.unstubAllGlobals();
	});

	async function keptOpenPastItsTime() {
		const unsubscribe = vi.fn(async () => true);
		vi.stubGlobal("Notification", { permission: "granted" });
		vi.stubGlobal("PushManager", function PushManager() {});
		Object.defineProperty(navigator, "serviceWorker", {
			configurable: true,
			value: {
				getRegistration: async () => ({
					pushManager: {
						getSubscription: async () => ({
							endpoint: "https://push.example.net/device",
							unsubscribe,
						}),
					},
				}),
			},
		});
		signIn("admin");
		const router = await visits([["/account", "Account"]]);
		const { useAuthStore } = await import("@/stores/auth");
		const { useUIStore } = await import("@/stores/ui");
		const auth = useAuthStore();
		const ui = useUIStore();
		ui.openComposeModal({ mode: "new" });
		if (auth.session) auth.session.expiresAt = Date.now() - 1;
		return { router, auth, ui, unsubscribe };
	}

	it("is forgotten here, and not signed out, once the server says it is gone", async () => {
		const { router, auth, ui, unsubscribe } = await keptOpenPastItsTime();
		me = "gone";
		await router.push("/mailbox/x%40example.com/emails/inbox");
		expect(router.currentRoute.value.name).toBe("Login");
		expect(auth.session).toBeNull();
		expect(signOutsSent).toBe(0);
		expect(unsubscribe).not.toHaveBeenCalled();
		expect(ui.isComposeModalOpen).toBe(true);
	});

	it("is kept while the server says it is good", async () => {
		const { router, auth, unsubscribe } = await keptOpenPastItsTime();
		await router.push("/mailbox/x%40example.com/emails/inbox");
		expect(router.currentRoute.value.name).toBe("EmailList");
		expect(auth.session?.id).toBe("s");
		expect(signOutsSent).toBe(0);
		expect(unsubscribe).not.toHaveBeenCalled();
	});
});
