import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rebindPushSubscription = vi.fn(async () => {});
let noticeShowing = false;
vi.mock("./push", () => ({
	rebindPushSubscription: () => rebindPushSubscription(),
	toldToOpenTheApp: async () => noticeShowing,
	letGoOfThisBrowsersSubscription: async () => {},
}));

const { listenForNotifications, openWhatWasTapped } = await import(
	"./notificationTap"
);
const { useAuthStore } = await import("@/stores/auth");

const indexHtml = Object.values(
	import.meta.glob("../../index.html", {
		query: "?raw",
		import: "default",
		eager: true,
	}) as Record<string, string>,
)[0];

const mainTs = Object.values(
	import.meta.glob("../main.ts", {
		query: "?raw",
		import: "default",
		eager: true,
	}) as Record<string, string>,
)[0];

beforeEach(() => {
	document.body.innerHTML = "";
});

/**
 * What is tested here is reached only through the entry point: a tap
 * handled inline in main.ts again would pass every test in this file.
 */
it("is what the entry point listens with", () => {
	expect(mainTs).toMatch(
		/\blistenForNotifications\(\s*navigator\.serviceWorker\b/,
	);
	expect(mainTs).not.toMatch(/serviceWorker\.addEventListener\(\s*["']message/);
});

describe("a tapped notification in an open tab", () => {
	it("shows what it was about", () => {
		const go = vi.fn();
		openWhatWasTapped({ type: "open", url: "/mailbox/a/email/1" }, go);
		expect(go).toHaveBeenCalledWith("/mailbox/a/email/1");
	});

	it("goes nowhere off this site", () => {
		const go = vi.fn();
		openWhatWasTapped({ type: "open", url: "//elsewhere.example/" }, go);
		openWhatWasTapped({ type: "open", url: "https://elsewhere.example/" }, go);
		openWhatWasTapped({ type: "other", url: "/login" }, go);
		openWhatWasTapped(null, go);
		expect(go).not.toHaveBeenCalled();
	});

	/**
	 * The tab comes to the front (the service worker does that) and stays
	 * where it is: a tap is not a decision to leave what is half written.
	 */
	it("stays where it is while something is being written", () => {
		const go = vi.fn();
		document.body.innerHTML = "<textarea>half a reply</textarea>";
		openWhatWasTapped({ type: "open", url: "/login" }, go);
		expect(go).not.toHaveBeenCalled();
	});
});

/**
 * A manifest is fetched without credentials unless the link asks for them.
 * Behind Cloudflare Access that request carries no Access cookie, and is
 * answered with the sign-in redirect instead of the manifest.
 */
describe("the manifest link", () => {
	it("is fetched with credentials", () => {
		const link = /<link\b[^>]*\brel="manifest"[^>]*>/.exec(indexHtml)?.[0];
		expect(link).toBeDefined();
		expect(link).toMatch(/\bcrossorigin="use-credentials"/);
	});
});

/**
 * A tab kept open and signed in, when the "open the app" notice comes. The
 * tap went to /login, which sends a signed-in tab away, and the session is
 * asked about once per page, so opening the app changed nothing for a
 * subscription not bound to the session: the notice came daily, and after
 * thirty days stopped. A tap, or the tab coming to the front with the notice
 * showing, hands the subscription over again.
 */
describe("a notification, in a tab that holds a session", () => {
	type Listener = (event: { data: unknown }) => void;
	let heard: Listener[] = [];
	const container = {
		addEventListener: (_type: string, listener: Listener) => {
			heard.push(listener);
		},
		removeEventListener: (_type: string, listener: Listener) => {
			heard = heard.filter((one) => one !== listener);
		},
	} as unknown as Pick<
		ServiceWorkerContainer,
		"addEventListener" | "removeEventListener"
	>;
	let stop = () => {};
	const listen = (go: (url: string) => void = () => {}) => {
		stop = listenForNotifications(container, go);
	};

	const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

	function signedIn(yes: boolean) {
		localStorage.clear();
		if (yes) {
			localStorage.setItem(
				"session",
				JSON.stringify({
					id: "s",
					userId: "u",
					email: "someone@example.com",
					role: "admin",
					expiresAt: Date.now() + 60_000,
				}),
			);
		}
		setActivePinia(createPinia());
		useAuthStore();
	}

	function comesToTheFront() {
		Object.defineProperty(document, "visibilityState", {
			configurable: true,
			get: () => "visible",
		});
		document.dispatchEvent(new Event("visibilitychange"));
	}

	beforeEach(() => {
		heard = [];
		noticeShowing = false;
		rebindPushSubscription.mockClear();
	});
	afterEach(() => {
		stop();
	});

	it("hands the subscription over when one is tapped", async () => {
		signedIn(true);
		listen();
		for (const listener of heard) {
			listener({ data: { type: "open", url: "/login" } });
		}
		await settle();
		expect(rebindPushSubscription).toHaveBeenCalledTimes(1);
	});

	it("hands it over when the tab comes to the front with the notice showing", async () => {
		signedIn(true);
		listen();
		noticeShowing = true;
		comesToTheFront();
		await settle();
		expect(rebindPushSubscription).toHaveBeenCalledTimes(1);
	});

	it("asks nothing of the server when the tab comes to the front without it", async () => {
		signedIn(true);
		listen();
		comesToTheFront();
		await settle();
		expect(rebindPushSubscription).not.toHaveBeenCalled();
	});

	/**
	 * The same event fires when the tab goes to the back. Nobody has opened
	 * anything then, so the notice stays and nothing is handed over.
	 */
	it("does nothing when the tab is hidden, notice or not", async () => {
		signedIn(true);
		listen();
		noticeShowing = true;
		Object.defineProperty(document, "visibilityState", {
			configurable: true,
			get: () => "hidden",
		});
		document.dispatchEvent(new Event("visibilitychange"));
		await settle();
		expect(rebindPushSubscription).not.toHaveBeenCalled();
	});

	it("does nothing of the kind with nobody signed in", async () => {
		signedIn(false);
		listen();
		noticeShowing = true;
		for (const listener of heard) {
			listener({ data: { type: "open", url: "/login" } });
		}
		comesToTheFront();
		await settle();
		expect(rebindPushSubscription).not.toHaveBeenCalled();
	});

	it("still shows what was tapped", () => {
		signedIn(true);
		const go = vi.fn();
		listen(go);
		for (const listener of heard) {
			listener({ data: { type: "open", url: "/mailbox/a/email/1" } });
		}
		expect(go).toHaveBeenCalledWith("/mailbox/a/email/1");
	});
});
