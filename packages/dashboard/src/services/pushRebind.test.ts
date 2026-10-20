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
const { i18n } = await import("@/i18n");
const { subscribeToPush, unsubscribeFromPush } = await import(
	"@/services/push"
);

const subscriptionJSON = {
	endpoint: "https://push.example.net/device",
	keys: { p256dh: "k", auth: "a" },
};

/**
 * What the Worker is handed: the subscription, and the language the page
 * displays, which a device whose session has run out is told in.
 */
const handedOver = (json: object) => ({
	...json,
	locale: i18n.global.locale.value,
});

/** The "open the app" notifications this browser shows; see browserWith. */
const shown: { tag: string; close: () => void }[] = [];
const getNotifications = vi.fn(async (filter?: { tag?: string }) =>
	shown.filter((n) => !filter?.tag || n.tag === filter.tag),
);

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
				getNotifications,
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
		getNotifications.mockClear();
		shown.length = 0;
	});
	afterEach(() => {
		// Each test's store would otherwise go on watching the language,
		// with its session, beside the next test's.
		useAuthStore().$dispose();
		vi.unstubAllGlobals();
		Reflect.deleteProperty(navigator, "serviceWorker");
	});

	it("is handed to the new session on login", async () => {
		browserWith("granted", subscriptionJSON);
		await useAuthStore().login("someone@example.com", "password");
		await settle();
		expect(subscribePush).toHaveBeenCalledTimes(1);
		expect(subscribePush).toHaveBeenCalledWith(handedOver(subscriptionJSON));
	});

	it("says which language the page displays", async () => {
		browserWith("granted", subscriptionJSON);
		await useAuthStore().login("someone@example.com", "password");
		await settle();
		expect(subscribePush).toHaveBeenCalledWith({
			...subscriptionJSON,
			locale: "en",
		});
	});

	/**
	 * The Worker tells a device whose session has run out in the language it
	 * last sent, so a language picked since is sent too.
	 */
	it("is handed over again when the language changes", async () => {
		browserWith("granted", subscriptionJSON);
		await useAuthStore().login("someone@example.com", "password");
		await settle();
		subscribePush.mockClear();
		const before = i18n.global.locale.value;
		try {
			i18n.global.locale.value = "fr";
			await settle();
			expect(subscribePush).toHaveBeenCalledWith({
				...subscriptionJSON,
				locale: "fr",
			});
		} finally {
			i18n.global.locale.value = before;
			await settle();
		}
	});

	it("is not handed over on a language change with nobody signed in", async () => {
		browserWith("granted", subscriptionJSON);
		useAuthStore();
		const before = i18n.global.locale.value;
		try {
			i18n.global.locale.value = "fr";
			await settle();
			expect(subscribePush).not.toHaveBeenCalled();
		} finally {
			i18n.global.locale.value = before;
			await settle();
		}
	});

	/**
	 * The app has been opened, which is what they asked for. Only once the
	 * Worker has the subscription: before that the device is still lapsed,
	 * and the next new mail would only ask again.
	 */
	it("closes the 'open the app' notifications once the Worker has it", async () => {
		browserWith("granted", subscriptionJSON);
		const close = vi.fn();
		const other = vi.fn();
		shown.push({ tag: "open-app", close }, { tag: "message-1", close: other });
		await useAuthStore().login("someone@example.com", "password");
		await settle();
		expect(getNotifications).toHaveBeenCalledWith({ tag: "open-app" });
		expect(close).toHaveBeenCalledTimes(1);
		expect(other).not.toHaveBeenCalled();
	});

	it("leaves them when the Worker did not take it", async () => {
		browserWith("granted", subscriptionJSON);
		const close = vi.fn();
		shown.push({ tag: "open-app", close });
		subscribePush.mockRejectedValueOnce(new Error("offline"));
		await useAuthStore().login("someone@example.com", "password");
		await settle();
		expect(close).not.toHaveBeenCalled();
	});

	it("is handed to the session found on load", async () => {
		browserWith("granted", subscriptionJSON);
		const auth = useAuthStore();
		await auth.login("someone@example.com", "password");
		await settle();
		subscribePush.mockClear();

		expect(await auth.checkAuth()).toBe(true);
		await settle();
		expect(subscribePush).toHaveBeenCalledWith(handedOver(subscriptionJSON));
	});

	it("asks for nothing when this browser has no subscription", async () => {
		browserWith("granted", null);
		await useAuthStore().login("someone@example.com", "password");
		await settle();
		expect(subscribePush).not.toHaveBeenCalled();
	});

	/**
	 * Sending back a subscription the browser already holds asks the browser
	 * for nothing, so the permission is not asked either. It used to be: a
	 * page opened outside the installed app may read a permission other than
	 * the app's, and a device that had just signed in again stayed unbound.
	 */
	it("is handed over whatever the permission reads", async () => {
		for (const permission of ["default", "denied"] as const) {
			subscribePush.mockClear();
			browserWith(permission, subscriptionJSON);
			await useAuthStore().login("someone@example.com", "password");
			await settle();
			expect(subscribePush).toHaveBeenCalledWith(handedOver(subscriptionJSON));
		}
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
	function browserSubscribedUnder(
		key: Uint8Array | null | undefined,
		permission: NotificationPermission = "granted",
	) {
		vi.stubGlobal("Notification", { permission });
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
					getNotifications: async () => [],
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
		expect(subscribePush).toHaveBeenCalledWith(handedOver(renewedJSON));
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

	/**
	 * A new subscription is the one thing here a browser may want a tap for,
	 * and only a granted permission lets a page subscribe without one. The
	 * old subscription is not handed over either: it is signed for with a
	 * key the Worker no longer has, and nothing would reach it.
	 */
	it("is not made again without the permission", async () => {
		servedKey = b64url(NEW);
		browserSubscribedUnder(OLD, "default");
		await useAuthStore().login("someone@example.com", "password");
		await settle();
		expect(steps).toEqual([]);
		expect(subscribedWith).toBeNull();
		expect(unsubscribePush).not.toHaveBeenCalled();
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
		expect(subscribePush).toHaveBeenCalledWith(handedOver(subscriptionJSON));
		expect(unsubscribePush).not.toHaveBeenCalled();
	});

	it("is handed over as it is when the Worker serves no key", async () => {
		servedKey = "";
		browserSubscribedUnder(OLD);
		await useAuthStore().login("someone@example.com", "password");
		await settle();
		expect(subscribePush).toHaveBeenCalledWith(handedOver(subscriptionJSON));
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
			expect(subscribePush).toHaveBeenCalledWith(handedOver(subscriptionJSON));
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
		expect(subscribePush).toHaveBeenCalledWith(handedOver(subscriptionJSON));
		expect(unsubscribePush).not.toHaveBeenCalled();
	});
});

/**
 * Turning notifications off. The browser used to let go only after the
 * Worker had been told, so a refusal left the device subscribed -- and told
 * about every new message -- with the switch reading off.
 */
describe("turning notifications off", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		Reflect.deleteProperty(navigator, "serviceWorker");
		unsubscribePush.mockReset();
		unsubscribePush.mockImplementation(async () => ({ data: {} }));
	});

	it("lets go in the browser even when the Worker was not told", async () => {
		const unsubscribe = vi.fn(async () => true);
		vi.stubGlobal("Notification", { permission: "granted" });
		vi.stubGlobal("PushManager", function PushManager() {});
		Object.defineProperty(navigator, "serviceWorker", {
			configurable: true,
			value: {
				ready: Promise.resolve({
					pushManager: {
						getSubscription: async () => ({
							endpoint: subscriptionJSON.endpoint,
							unsubscribe,
						}),
					},
				}),
			},
		});
		unsubscribePush.mockRejectedValueOnce(new Error("offline"));
		await expect(unsubscribeFromPush()).rejects.toThrow("offline");
		expect(unsubscribe).toHaveBeenCalledTimes(1);
	});
});

/**
 * Turning notifications on says the language too, as the hand-over does: a
 * device switched on and then left until its session ran out was told in no
 * language of its own.
 */
describe("turning notifications on", () => {
	beforeEach(() => {
		subscribePush.mockClear();
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		Reflect.deleteProperty(navigator, "serviceWorker");
		servedKey = "";
	});

	it("says which language the page displays", async () => {
		servedKey = "BAEC";
		vi.stubGlobal("Notification", {
			permission: "default",
			requestPermission: async () => "granted",
		});
		vi.stubGlobal("PushManager", function PushManager() {});
		Object.defineProperty(navigator, "serviceWorker", {
			configurable: true,
			value: {
				ready: Promise.resolve({
					pushManager: {
						subscribe: async () => ({ toJSON: () => subscriptionJSON }),
					},
				}),
			},
		});
		await subscribeToPush();
		expect(subscribePush).toHaveBeenCalledTimes(1);
		expect(subscribePush).toHaveBeenCalledWith(handedOver(subscriptionJSON));
	});
});
