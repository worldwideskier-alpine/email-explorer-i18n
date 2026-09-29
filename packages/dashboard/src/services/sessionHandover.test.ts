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

describe("a sign-out the server did not hear", () => {
	it("is sent again the next time the dashboard opens", async () => {
		await signIn("first");
		const out = useAuthStore().logout();
		await settle();
		take("/api/v1/auth/logout").settle(503);
		await new Promise((r) => setTimeout(r, 1100));
		await settle();
		take("/api/v1/auth/logout").settle(503);
		await out;

		expect(useAuthStore().session).toBeNull();
		expect(localStorage.getItem("signOutPending")).toBe("first");

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

	it("is not remembered when the server heard it", async () => {
		await signIn("first");
		const out = useAuthStore().logout();
		await settle();
		take("/api/v1/auth/logout").settle(200);
		await out;
		expect(localStorage.getItem("signOutPending")).toBeNull();
	});
});
