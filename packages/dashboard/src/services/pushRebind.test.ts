import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A browser's push subscription follows whoever signs in on it.
 *
 * The Worker delivers only through a session that is still good, and drops a
 * session's subscription when the session ends. The browser keeps its
 * subscription regardless, and the settings switch is read from the browser,
 * so without handing the subscription to the new session, signing out and
 * back in left the switch on and the notifications off.
 */

const subscribePush = vi.fn(async (_sub: unknown) => ({ data: {} }));

vi.mock("@/services/api", () => ({
	default: {
		login: vi.fn(async () => ({
			data: {
				id: "session-1",
				userId: "user-1",
				email: "someone@example.com",
				role: "admin",
				expiresAt: Date.now() + 60_000,
			},
		})),
		setAuthToken: vi.fn(),
		getCurrentUser: vi.fn(async () => ({
			data: { id: "user-1", email: "someone@example.com", role: "admin" },
		})),
		logout: vi.fn(async () => ({ data: {} })),
		subscribePush: (sub: unknown) => subscribePush(sub),
	},
}));

const { useAuthStore } = await import("@/stores/auth");

const subscriptionJSON = {
	endpoint: "https://push.example.net/device",
	keys: { p256dh: "k", auth: "a" },
};

function browserWith(
	permission: NotificationPermission,
	subscription: object | null,
) {
	vi.stubGlobal("Notification", { permission });
	vi.stubGlobal("PushManager", function PushManager() {});
	Object.defineProperty(navigator, "serviceWorker", {
		configurable: true,
		value: {
			ready: Promise.resolve({
				pushManager: {
					getSubscription: async () =>
						subscription && { toJSON: () => subscription },
				},
			}),
		},
	});
}

/** The re-bind is not awaited by the store; let it finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the push subscription after signing in", () => {
	beforeEach(() => {
		setActivePinia(createPinia());
		localStorage.clear();
		subscribePush.mockClear();
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		Reflect.deleteProperty(navigator, "serviceWorker");
	});

	it("is handed to the new session on login", async () => {
		browserWith("granted", subscriptionJSON);
		await useAuthStore().login("someone@example.com", "password");
		await settle();
		expect(subscribePush).toHaveBeenCalledTimes(1);
		expect(subscribePush).toHaveBeenCalledWith(subscriptionJSON);
	});

	it("is handed to the session found on load", async () => {
		browserWith("granted", subscriptionJSON);
		const auth = useAuthStore();
		await auth.login("someone@example.com", "password");
		await settle();
		subscribePush.mockClear();

		expect(await auth.checkAuth()).toBe(true);
		await settle();
		expect(subscribePush).toHaveBeenCalledWith(subscriptionJSON);
	});

	it("asks for nothing when this browser has no subscription", async () => {
		browserWith("granted", null);
		await useAuthStore().login("someone@example.com", "password");
		await settle();
		expect(subscribePush).not.toHaveBeenCalled();
	});

	it("asks for nothing when permission is not already granted", async () => {
		browserWith("default", subscriptionJSON);
		await useAuthStore().login("someone@example.com", "password");
		await settle();
		expect(subscribePush).not.toHaveBeenCalled();
	});

	it("does not fail the login when handing it over fails", async () => {
		browserWith("granted", subscriptionJSON);
		subscribePush.mockRejectedValueOnce(new Error("offline"));
		const session = await useAuthStore().login(
			"someone@example.com",
			"password",
		);
		await settle();
		expect(session?.id).toBe("session-1");
	});
});
