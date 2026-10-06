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

/** What happened, in order, across the Worker and the browser. */
const steps: string[] = [];
/** The public key the Worker serves; "" when it has none. */
let servedKey = "";

const subscribePush = vi.fn(async (_sub: unknown) => {
	steps.push("Worker is handed it");
	return { data: {} };
});
const unsubscribePush = vi.fn(async (_endpoint: string) => {
	steps.push("Worker forgets the old one");
	return { data: {} };
});
const getVapidPublicKey = vi.fn(async () => ({
	data: { publicKey: servedKey },
}));

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
		clearAuthToken: vi.fn(),
		getCurrentUser: vi.fn(async () => ({
			data: { id: "user-1", email: "someone@example.com", role: "admin" },
		})),
		logout: vi.fn(async () => ({ data: {} })),
		subscribePush: (sub: unknown) => subscribePush(sub),
		unsubscribePush: (endpoint: string) => unsubscribePush(endpoint),
		getVapidPublicKey: () => getVapidPublicKey(),
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

/**
 * A subscription made under a key the Worker no longer has.
 *
 * A push service refuses a push signed with any key but the one the browser
 * subscribed with. When the Worker's key is replaced -- its secret deleted,
 * and the next deploy makes a new one -- every device would stay subscribed
 * under the old key with its switch on, receiving nothing. Opening the
 * dashboard makes the subscription again under the key the Worker serves.
 */
describe("a subscription made under another key", () => {
	const OLD = Uint8Array.from({ length: 65 }, (_, i) => (i === 0 ? 4 : i));
	const NEW = Uint8Array.from({ length: 65 }, (_, i) =>
		i === 0 ? 4 : 100 + i,
	);
	const b64url = (bytes: Uint8Array) =>
		btoa(String.fromCharCode(...bytes))
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "");
	const renewedJSON = {
		endpoint: "https://push.example.net/device-renewed",
		keys: { p256dh: "k2", auth: "a2" },
	};
	let subscribedWith: Uint8Array | null = null;

	/** A browser whose subscription was made under `key`, or says nothing of one. */
	function browserSubscribedUnder(key: Uint8Array | null | undefined) {
		vi.stubGlobal("Notification", { permission: "granted" });
		vi.stubGlobal("PushManager", function PushManager() {});
		const existing = {
			endpoint: subscriptionJSON.endpoint,
			options:
				key === undefined
					? undefined
					: { applicationServerKey: key?.slice().buffer ?? null },
			toJSON: () => subscriptionJSON,
			unsubscribe: async () => {
				steps.push("browser lets go");
				return true;
			},
		};
		Object.defineProperty(navigator, "serviceWorker", {
			configurable: true,
			value: {
				ready: Promise.resolve({
					pushManager: {
						getSubscription: async () => existing,
						subscribe: async (options: {
							applicationServerKey: Uint8Array;
						}) => {
							steps.push("browser subscribes");
							subscribedWith = new Uint8Array(options.applicationServerKey);
							return { toJSON: () => renewedJSON };
						},
					},
				}),
			},
		});
	}

	beforeEach(() => {
		setActivePinia(createPinia());
		localStorage.clear();
		subscribePush.mockClear();
		unsubscribePush.mockClear();
		getVapidPublicKey.mockClear();
		steps.length = 0;
		subscribedWith = null;
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		Reflect.deleteProperty(navigator, "serviceWorker");
		servedKey = "";
	});

	it("is made again under the key the Worker serves", async () => {
		servedKey = b64url(NEW);
		browserSubscribedUnder(OLD);
		await useAuthStore().login("someone@example.com", "password");
		await settle();
		expect(steps).toEqual([
			"Worker forgets the old one",
			"browser lets go",
			"browser subscribes",
			"Worker is handed it",
		]);
		expect(unsubscribePush).toHaveBeenCalledWith(subscriptionJSON.endpoint);
		expect(subscribedWith).toEqual(NEW);
		expect(subscribePush).toHaveBeenCalledTimes(1);
		expect(subscribePush).toHaveBeenCalledWith(renewedJSON);
	});

	/**
	 * Not before: a browser that let go of a subscription the Worker still
	 * holds leaves a row the Worker goes on pushing to, and is refused on,
	 * for every new message.
	 */
	it("is let go by the browser only once the Worker has forgotten it", async () => {
		servedKey = b64url(NEW);
		browserSubscribedUnder(OLD);
		let forget = () => {};
		unsubscribePush.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					forget = () => {
						steps.push("Worker forgets the old one");
						resolve({ data: {} });
					};
				}),
		);
		await useAuthStore().login("someone@example.com", "password");
		await settle();
		expect(unsubscribePush).toHaveBeenCalledWith(subscriptionJSON.endpoint);
		expect(steps).toEqual([]);

		forget();
		await settle();
		expect(steps).toEqual([
			"Worker forgets the old one",
			"browser lets go",
			"browser subscribes",
			"Worker is handed it",
		]);
	});

	it("is kept as it is when the Worker does not forget the old one", async () => {
		servedKey = b64url(NEW);
		browserSubscribedUnder(OLD);
		unsubscribePush.mockRejectedValueOnce(new Error("offline"));
		const session = await useAuthStore().login(
			"someone@example.com",
			"password",
		);
		await settle();
		expect(session?.id).toBe("session-1");
		expect(steps).toEqual([]);
		expect(subscribedWith).toBeNull();
		expect(subscribePush).not.toHaveBeenCalled();
	});

	it("is handed over as it is when the keys are the same", async () => {
		servedKey = b64url(OLD);
		browserSubscribedUnder(OLD);
		await useAuthStore().login("someone@example.com", "password");
		await settle();
		expect(steps).toEqual(["Worker is handed it"]);
		expect(subscribePush).toHaveBeenCalledWith(subscriptionJSON);
		expect(unsubscribePush).not.toHaveBeenCalled();
	});

	it("is handed over as it is when the Worker serves no key", async () => {
		servedKey = "";
		browserSubscribedUnder(OLD);
		await useAuthStore().login("someone@example.com", "password");
		await settle();
		expect(subscribePush).toHaveBeenCalledWith(subscriptionJSON);
		expect(unsubscribePush).not.toHaveBeenCalled();
		expect(subscribedWith).toBeNull();
	});

	it("is handed over as it is when the browser does not say its key", async () => {
		servedKey = b64url(NEW);
		for (const unsaid of [undefined, null]) {
			subscribePush.mockClear();
			browserSubscribedUnder(unsaid);
			await useAuthStore().login("someone@example.com", "password");
			await settle();
			expect(subscribePush).toHaveBeenCalledWith(subscriptionJSON);
			expect(unsubscribePush).not.toHaveBeenCalled();
			expect(subscribedWith).toBeNull();
		}
	});

	it("is handed over as it is when the Worker's key cannot be read", async () => {
		servedKey = b64url(NEW);
		getVapidPublicKey.mockRejectedValueOnce(new Error("offline"));
		browserSubscribedUnder(OLD);
		await useAuthStore().login("someone@example.com", "password");
		await settle();
		expect(subscribePush).toHaveBeenCalledWith(subscriptionJSON);
		expect(unsubscribePush).not.toHaveBeenCalled();
	});
});
