import type { AxiosAdapter, InternalAxiosRequestConfig } from "axios";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "@/stores/auth";
import { useMailboxStore } from "@/stores/mailboxes";
import { useUIStore } from "@/stores/ui";
import { apiClient, leave } from "./api";
import { sessionEnded } from "./sessionEnd";

/**
 * One tab, two people: what the first leaves behind for the second.
 *
 * A session that ran out mid-way used to take only itself: the mailbox list,
 * the search results and the open message stayed, and answers already on
 * their way landed afterwards -- in front of whoever signed in next. A late
 * 401 among them ended the new session. And a sign-out the server did not
 * hear was forgotten, leaving the session alive there for thirty days.
 */

type Pending = {
	config: InternalAxiosRequestConfig;
	settle: (status: number, data?: unknown) => void;
};
const pending: Pending[] = [];

/** Holds every request until the test answers it. */
const held: AxiosAdapter = (config) =>
	new Promise((resolve, reject) => {
		pending.push({
			config,
			settle(status, data = {}) {
				const response = { data, status, statusText: "", headers: {}, config };
				if (status < 400) resolve(response);
				else
					reject(
						Object.assign(new Error(`status ${status}`), {
							response,
							config,
							isAxiosError: true,
						}),
					);
			},
		});
	});

const take = (url: string) => {
	const found = pending.find((p) => p.config.url === url);
	if (!found) throw new Error(`no request for ${url}`);
	pending.splice(pending.indexOf(found), 1);
	return found;
};

const settle = async () => {
	for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

const session = (id: string) => ({
	id,
	userId: `user-${id}`,
	email: `${id}@example.com`,
	role: "admin",
	expiresAt: Date.now() + 60_000,
});

async function signIn(id: string) {
	const auth = useAuthStore();
	const signing = auth.login(`${id}@example.com`, "password");
	await settle();
	take("/api/v1/auth/login").settle(200, session(id));
	await signing;
}

beforeEach(() => {
	pending.length = 0;
	localStorage.clear();
	apiClient.defaults.adapter = held;
	setActivePinia(createPinia());
	vi.spyOn(leave, "to").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("an answer to a session that has ended", () => {
	it("is not shown to the next person", async () => {
		await signIn("first");
		const mailboxes = useMailboxStore();
		const listing = mailboxes.fetchMailboxes();
		await settle();

		sessionEnded();
		await signIn("second");
		take("/api/v1/mailboxes").settle(200, [{ id: "first@example.com" }]);
		await settle();

		expect(mailboxes.mailboxes).toEqual([]);
		void listing;
	});

	it("does not end the next person's session with its 401", async () => {
		await signIn("first");
		void useMailboxStore()
			.fetchMailboxes()
			.catch(() => {});
		await settle();

		sessionEnded();
		await signIn("second");
		take("/api/v1/mailboxes").settle(401, { error: "Unauthorized" });
		await settle();

		expect(useAuthStore().session?.id).toBe("second");
	});
});

describe("a session that ends while nothing new has started", () => {
	it("empties what was shown, and keeps a message being written", async () => {
		await signIn("first");
		const mailboxes = useMailboxStore();
		mailboxes.mailboxes = [{ id: "first@example.com" } as never];
		const ui = useUIStore();
		ui.openComposeModal({ mode: "reply", originalEmail: { id: "theirs" } });

		sessionEnded();
		expect(mailboxes.mailboxes).toEqual([]);
		expect(ui.isComposeModalOpen).toBe(true);

		// And the composer, with the last person's original in it, does not
		// open again for the next.
		await signIn("second");
		expect(ui.isComposeModalOpen).toBe(false);
		expect(ui.composeOptions.originalEmail).toBeNull();
	});
});

/** A browser holding a push subscription; `unsubscribe` says if it let go. */
function browserSubscribed() {
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
	return unsubscribe;
}

describe("signing out on purpose", () => {
	afterEach(() => {
		Reflect.deleteProperty(navigator, "serviceWorker");
	});

	/**
	 * Before the first attempt, not after the second: written only once both
	 * had failed, a tab closed or reloaded in the second between them lost
	 * the sign-out, and the session and its subscription lived on.
	 */
	it("is written down before it is sent", async () => {
		await signIn("first");
		const out = useAuthStore().signOut();
		await settle();
		expect(localStorage.getItem("signOutPending")).toBe('["first"]');
		take("/api/v1/auth/logout").settle(200);
		await out;
		expect(localStorage.getItem("signOutPending")).toBeNull();
	});

	/**
	 * The Worker signs out any session it is named and never answers 401,
	 * so a 401 is something in front of it -- an Access sign-in that has
	 * lapsed -- and the Worker has heard nothing.
	 */
	it("stays pending when the answer is a 401", async () => {
		await signIn("first");
		const out = useAuthStore().signOut();
		await settle();
		take("/api/v1/auth/logout").settle(401);
		await new Promise((r) => setTimeout(r, 1100));
		await settle();
		take("/api/v1/auth/logout").settle(401);
		await out;
		expect(localStorage.getItem("signOutPending")).toBe('["first"]');

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("{}", { status: 401 })),
		);
		setActivePinia(createPinia());
		useAuthStore();
		await new Promise((r) => setTimeout(r, 1100));
		await settle();
		expect(localStorage.getItem("signOutPending")).toBe('["first"]');
	});

	/**
	 * Before the server is asked, not after it answered: two attempts and a
	 * second's wait, and a tab closed in that time stayed subscribed.
	 */
	it("lets go of this browser's push subscription before the server is asked", async () => {
		const unsubscribe = browserSubscribed();
		await signIn("first");
		const out = useAuthStore().signOut();
		await settle();
		expect(unsubscribe).toHaveBeenCalledTimes(1);
		take("/api/v1/auth/logout").settle(200);
		await out;
	});

	/**
	 * Each attempt names the session being signed out. The token used to be
	 * read from storage as each request went out, so the second attempt, a
	 * second later, carried whatever another tab had stored since -- and
	 * ended that tab's new session.
	 */
	it("names its own session, whatever another tab has stored since", async () => {
		await signIn("first");
		const out = useAuthStore().signOut();
		await settle();
		const first = take("/api/v1/auth/logout");
		expect(first.config.headers.Authorization).toBe("Bearer first");
		localStorage.setItem("session", JSON.stringify(session("second")));
		first.settle(503);
		await new Promise((r) => setTimeout(r, 1100));
		await settle();
		const second = take("/api/v1/auth/logout");
		expect(second.config.headers.Authorization).toBe("Bearer first");
		second.settle(200);
		await out;
	});

	/**
	 * Whatever the server said: a device signed out on purpose is told
	 * nothing more, not even, once its session has run out, to open the app.
	 */
	it("lets go of this browser's push subscription even when the server failed", async () => {
		const unsubscribe = browserSubscribed();
		await signIn("first");
		const out = useAuthStore().signOut();
		await settle();
		take("/api/v1/auth/logout").settle(503);
		await new Promise((r) => setTimeout(r, 1100));
		await settle();
		take("/api/v1/auth/logout").settle(503);
		await out;
		expect(unsubscribe).toHaveBeenCalledTimes(1);
		expect(useAuthStore().session).toBeNull();
	});

	/**
	 * The sign-out waits for the browser to let go, and a browser can fail
	 * to answer at either step: a service worker that never hands back its
	 * registration, or an unsubscribe that never settles. Two seconds
	 * (LET_GO_WITHIN_MS), then the sign-out goes on without it: a person
	 * pressing "sign out" and staying signed in is the worse of the two.
	 */
	it("waits no more than two seconds for a browser that does not let go", async () => {
		const never = () => new Promise<never>(() => {});
		const browsersThatHang = [
			{ getRegistration: never },
			{
				getRegistration: async () => ({
					pushManager: {
						getSubscription: async () => ({
							endpoint: "https://push.example.net/device",
							unsubscribe: never,
						}),
					},
				}),
			},
		];
		vi.stubGlobal("Notification", { permission: "granted" });
		vi.stubGlobal("PushManager", function PushManager() {});
		for (const [i, serviceWorker] of browsersThatHang.entries()) {
			Object.defineProperty(navigator, "serviceWorker", {
				configurable: true,
				value: serviceWorker,
			});
			await signIn(`hangs-${i}`);
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			let out: Promise<void>;
			try {
				out = useAuthStore().signOut();
				await vi.advanceTimersByTimeAsync(1_999);
				expect(pending.map((p) => p.config.url)).toEqual([]);
				await vi.advanceTimersByTimeAsync(1);
			} finally {
				vi.useRealTimers();
			}
			await settle();
			take("/api/v1/auth/logout").settle(200);
			await out;
			expect(useAuthStore().session).toBeNull();
		}
	});
});

/**
 * A session that runs out, or that the server says is gone, is not a
 * sign-out. Asking the server to end it deleted the subscription the Worker
 * tells a lapsed device to open the app through -- the one thing that brings
 * a phone used only for notifications back -- and the browser let go of its
 * own as well.
 */
describe("a session that ends by itself", () => {
	afterEach(() => {
		Reflect.deleteProperty(navigator, "serviceWorker");
	});

	async function signedInWithAComposer(expiresAt: number) {
		const unsubscribe = browserSubscribed();
		localStorage.setItem(
			"session",
			JSON.stringify({ ...session("first"), expiresAt }),
		);
		const auth = useAuthStore();
		const ui = useUIStore();
		ui.openComposeModal({ mode: "new" });
		return { auth, ui, unsubscribe };
	}

	/**
	 * Past its time by this device's clock, it is the server that is asked:
	 * a clock running ahead used to end a session the server still held,
	 * whose device went on being told sender and subject.
	 */
	it("asks the server only whether it has run out, when it has here", async () => {
		const { auth, ui, unsubscribe } = await signedInWithAComposer(
			Date.now() - 1,
		);
		const checking = auth.checkAuth();
		await settle();
		take("/api/v1/auth/me").settle(401);
		expect(await checking).toBe(false);
		await settle();
		expect(pending.map((p) => p.config.url)).toEqual([]);
		expect(auth.session).toBeNull();
		expect(unsubscribe).not.toHaveBeenCalled();
		expect(ui.isComposeModalOpen).toBe(true);
		expect(localStorage.getItem("signOutPending")).toBeNull();
	});

	it("is kept when the server says it has not run out, whatever the clock here", async () => {
		const { auth } = await signedInWithAComposer(Date.now() - 1);
		const checking = auth.checkAuth();
		await settle();
		take("/api/v1/auth/me").settle(200, {
			id: "user-first",
			email: "first@example.com",
			role: "admin",
		});
		expect(await checking).toBe(true);
		await settle();
		expect(auth.session?.id).toBe("first");
		expect(
			pending.filter((p) => p.config.url === "/api/v1/auth/logout"),
		).toEqual([]);
	});

	it("asks the server nothing more when it answers 401", async () => {
		const { auth, ui, unsubscribe } = await signedInWithAComposer(
			Date.now() + 60_000,
		);
		const checking = auth.checkAuth();
		await settle();
		take("/api/v1/auth/me").settle(401);
		expect(await checking).toBe(false);
		await settle();
		expect(pending.map((p) => p.config.url)).toEqual([]);
		expect(auth.session).toBeNull();
		expect(unsubscribe).not.toHaveBeenCalled();
		expect(ui.isComposeModalOpen).toBe(true);
	});

	/**
	 * The route answers 200 or 401. A 403 comes from the Access check in
	 * front of it and says nothing about this session.
	 */
	it("is not ended by a 403", async () => {
		const { auth } = await signedInWithAComposer(Date.now() + 60_000);
		const checking = auth.checkAuth();
		await settle();
		take("/api/v1/auth/me").settle(403, { error: "Forbidden" });
		expect(await checking).toBe(true);
		expect(auth.session?.id).toBe("first");
		expect(pending.map((p) => p.config.url)).toEqual([]);
	});
});

describe("a sign-out the server did not hear", () => {
	it("is sent again the next time the dashboard opens", async () => {
		await signIn("first");
		const out = useAuthStore().signOut();
		await settle();
		take("/api/v1/auth/logout").settle(503);
		await new Promise((r) => setTimeout(r, 1100));
		await settle();
		take("/api/v1/auth/logout").settle(503);
		await out;

		expect(useAuthStore().session).toBeNull();
		expect(localStorage.getItem("signOutPending")).toBe('["first"]');

		const sent: RequestInit[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init: RequestInit) => {
				sent.push(init);
				return new Response("{}", { status: 200 });
			}),
		);
		setActivePinia(createPinia());
		useAuthStore();
		await settle();

		expect(sent).toHaveLength(1);
		expect(new Headers(sent[0].headers).get("Authorization")).toBe(
			"Bearer first",
		);
		expect(localStorage.getItem("signOutPending")).toBeNull();
	});

	/**
	 * One slot used to hold it: the next sign-out wrote over it before it
	 * was sent and crossed it off when it was heard, and the earlier session
	 * lived on for thirty days.
	 */
	it("survives a later sign-out the server heard, and is sent with its own token", async () => {
		await signIn("first");
		const out = useAuthStore().signOut();
		await settle();
		take("/api/v1/auth/logout").settle(503);
		await new Promise((r) => setTimeout(r, 1100));
		await settle();
		take("/api/v1/auth/logout").settle(503);
		await out;

		await signIn("second");
		const again = useAuthStore().signOut();
		await settle();
		take("/api/v1/auth/logout").settle(200);
		await again;
		expect(localStorage.getItem("signOutPending")).toBe('["first"]');

		const sent: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init: RequestInit) => {
				sent.push(new Headers(init.headers).get("Authorization") ?? "");
				return new Response("{}", { status: 200 });
			}),
		);
		setActivePinia(createPinia());
		useAuthStore();
		await settle();
		expect(sent).toEqual(["Bearer first"]);
		expect(localStorage.getItem("signOutPending")).toBeNull();
	});

	/**
	 * A list, but not one without end: a browser that never reaches the
	 * server would grow it with every sign-out. Past ten, the oldest is let
	 * go.
	 */
	it("lets the oldest go once ten are waiting", async () => {
		await signIn("eleventh");
		const older = Array.from({ length: 10 }, (_, i) => `older-${i}`);
		localStorage.setItem("signOutPending", JSON.stringify(older));
		const out = useAuthStore().signOut();
		await settle();
		expect(JSON.parse(localStorage.getItem("signOutPending") ?? "[]")).toEqual([
			...older.slice(1),
			"eleventh",
		]);
		take("/api/v1/auth/logout").settle(200);
		await out;
		expect(JSON.parse(localStorage.getItem("signOutPending") ?? "[]")).toEqual(
			older.slice(1),
		);
	});

	it("is sent when an older build kept it as one bare token", async () => {
		localStorage.setItem("signOutPending", "first");
		const sent: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init: RequestInit) => {
				sent.push(new Headers(init.headers).get("Authorization") ?? "");
				return new Response("{}", { status: 200 });
			}),
		);
		useAuthStore();
		await settle();
		expect(sent).toEqual(["Bearer first"]);
		expect(localStorage.getItem("signOutPending")).toBeNull();
	});

	/**
	 * A tab closed before the browser let go left it subscribed, and the
	 * next sign-in here hands the subscription to whoever that is. Not
	 * while somebody is signed in, whose subscription it may be by now.
	 */
	it("lets go of this browser's subscription when nobody is signed in here", async () => {
		const unsubscribe = browserSubscribed();
		localStorage.setItem("signOutPending", '["first"]');
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("{}", { status: 200 })),
		);
		useAuthStore();
		await settle();
		expect(unsubscribe).toHaveBeenCalledTimes(1);
		Reflect.deleteProperty(navigator, "serviceWorker");
	});

	it("leaves this browser's subscription to whoever is signed in here", async () => {
		const unsubscribe = browserSubscribed();
		localStorage.setItem("signOutPending", '["first"]');
		localStorage.setItem("session", JSON.stringify(session("second")));
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("{}", { status: 200 })),
		);
		useAuthStore();
		await settle();
		expect(unsubscribe).not.toHaveBeenCalled();
		expect(localStorage.getItem("signOutPending")).toBeNull();
		Reflect.deleteProperty(navigator, "serviceWorker");
	});

	it("is not remembered when the server heard it", async () => {
		await signIn("first");
		const out = useAuthStore().signOut();
		await settle();
		take("/api/v1/auth/logout").settle(200);
		await out;
		expect(localStorage.getItem("signOutPending")).toBeNull();
	});
});
