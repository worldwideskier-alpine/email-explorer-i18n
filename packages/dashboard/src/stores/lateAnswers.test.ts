import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * An answer to a request nobody is waiting for any more is not shown, and a
 * hiccup is not a signed-out session.
 */

const pending: Record<string, (value: unknown) => void> = {};
const later = (key: string) =>
	new Promise((resolve) => {
		pending[key] = resolve;
	});

let listed = 0;
const getCurrentUser = vi.fn();
const logout = vi.fn(async () => ({ data: {} }));

vi.mock("@/services/api", () => ({
	default: {
		searchEmails: (mailboxId: string, params: { query: string }) =>
			later(`search:${mailboxId}:${params.query}`),
		getMailbox: (id: string) => later(`mailbox:${id}`),
		listContacts: (id: string) => later(`contacts:${id}`),
		listMailboxes: () => later(`mailboxes:${++listed}`),
		createFolder: (id: string, name: string) => later(`folder:${id}:${name}`),
		listFolders: (id: string) => later(`folders:${id}`),
		updateMailbox: (id: string) => later(`update:${id}`),
		getCurrentUser: () => getCurrentUser(),
		logout: () => logout(),
		setAuthToken: vi.fn(),
		clearAuthToken: vi.fn(),
	},
}));

const { useSearchStore } = await import("./search");
const { useMailboxStore } = await import("./mailboxes");
const { useAuthStore } = await import("./auth");
const { useContactStore } = await import("./contacts");
const { useFolderStore } = await import("./folders");

beforeEach(() => {
	setActivePinia(createPinia());
	localStorage.clear();
	getCurrentUser.mockReset();
	logout.mockClear();
});

describe("search", () => {
	it("shows the latest query's results, whichever answer comes last", async () => {
		const store = useSearchStore();
		const first = store.searchEmails("m", "a");
		const second = store.searchEmails("m", "b");
		pending["search:m:b"]({ data: [{ id: "b1" }] });
		await second;
		pending["search:m:a"]({ data: [{ id: "a1" }] });
		await first;
		expect(store.results.map((r) => r.id)).toEqual(["b1"]);
		expect(store.isLoading).toBe(false);
	});

	it("does not show one mailbox's results while another's are loading", async () => {
		const store = useSearchStore();
		const one = store.searchEmails("one", "q");
		pending["search:one:q"]({ data: [{ id: "x" }] });
		await one;
		const two = store.searchEmails("two", "q");
		expect(store.results).toEqual([]);
		expect(store.mailboxId).toBe("two");
		pending["search:two:q"]({ data: [] });
		await two;
	});
});

describe("the open mailbox", () => {
	it("is not the previous one while the next is loading", async () => {
		const store = useMailboxStore();
		const a = store.fetchMailbox("a");
		pending["mailbox:a"]({ data: { id: "a" } });
		await a;
		const b = store.fetchMailbox("b");
		expect(store.currentMailbox).toBeNull();
		pending["mailbox:b"]({ data: { id: "b" } });
		await b;
		expect(store.currentMailbox?.id).toBe("b");
	});

	it("is the one asked for last, whichever answer comes last", async () => {
		const store = useMailboxStore();
		const a = store.fetchMailbox("a");
		const b = store.fetchMailbox("b");
		pending["mailbox:b"]({ data: { id: "b" } });
		await b;
		pending["mailbox:a"]({ data: { id: "a" } });
		await a;
		expect(store.currentMailbox?.id).toBe("b");
	});
});

describe("a save's answer", () => {
	/**
	 * It replaced whatever mailbox was open when it arrived -- after a switch,
	 * the settings screen of one mailbox showing another's.
	 */
	it("does not replace a mailbox opened since", async () => {
		const store = useMailboxStore();
		const b = store.fetchMailbox("b");
		pending["mailbox:b"]({ data: { id: "b" } });
		await b;
		const save = store.updateMailbox("a", {});
		pending["update:a"]({ data: { id: "a" } });
		await save;
		expect(store.currentMailbox?.id).toBe("b");
	});
});

describe("checking the stored session", () => {
	const signedIn = () => {
		localStorage.setItem(
			"session",
			JSON.stringify({
				id: "s",
				userId: "u",
				email: "e@example.com",
				role: "admin",
				expiresAt: Date.now() + 60_000,
			}),
		);
		return useAuthStore();
	};

	/** A dropped connection is not the server saying the session is gone. */
	it("keeps the session through a network error", async () => {
		const auth = signedIn();
		getCurrentUser.mockRejectedValueOnce(new Error("Network Error"));
		expect(await auth.checkAuth()).toBe(true);
		expect(auth.session).not.toBeNull();
		expect(logout).not.toHaveBeenCalled();
	});

	it("keeps it through a server error", async () => {
		const auth = signedIn();
		getCurrentUser.mockRejectedValueOnce({ response: { status: 503 } });
		expect(await auth.checkAuth()).toBe(true);
		expect(logout).not.toHaveBeenCalled();
	});

	it("ends it when the server says it is no good", async () => {
		const auth = signedIn();
		getCurrentUser.mockRejectedValueOnce({ response: { status: 401 } });
		expect(await auth.checkAuth()).toBe(false);
		expect(auth.session).toBeNull();
	});
});

describe("choosing a language", () => {
	/**
	 * A catalogue not yet loaded takes a moment; one chosen after it that is
	 * already loaded must not be overtaken by it.
	 */
	it("ends on the one chosen last", async () => {
		const { i18n, setLocale } = await import("@/i18n");
		await setLocale("en");
		const slow = setLocale("ja");
		const fast = setLocale("en");
		await Promise.all([slow, fast]);
		expect(i18n.global.locale.value).toBe("en");
		expect(localStorage.getItem("email-explorer-locale")).toBe("en");
	});
});

/**
 * The same for the lists that had no such guard: contacts, the mailbox list,
 * and a folder made in one mailbox and answered once the reader was in
 * another.
 */
describe("the lists that had no guard", () => {
	it("keep one mailbox's contacts out of the next", async () => {
		const store = useContactStore();
		const first = store.fetchContacts("one");
		const second = store.fetchContacts("two");
		pending["contacts:two"]({
			data: [{ id: 2, name: "b", email: "b@example.com" }],
		});
		await second;
		pending["contacts:one"]({
			data: [{ id: 1, name: "a", email: "a@example.com" }],
		});
		await first;
		expect(store.contacts.map((c) => c.id)).toEqual([2]);
	});

	it("keep the latest mailbox list", async () => {
		const store = useMailboxStore();
		listed = 0;
		const older = store.fetchMailboxes();
		const newer = store.fetchMailboxes();
		pending["mailboxes:2"]({ data: [{ id: "new@example.com" }] });
		await newer;
		pending["mailboxes:1"]({ data: [] });
		await older;
		expect(store.mailboxes.map((m) => m.id)).toEqual(["new@example.com"]);
	});

	it("put a new folder only in its own mailbox's list", async () => {
		const store = useFolderStore();
		const loadOne = store.fetchFolders("one");
		pending["folders:one"]({ data: [] });
		await loadOne;
		const made = store.createFolder("one", "Receipts");
		const loadTwo = store.fetchFolders("two");
		pending["folders:two"]({ data: [{ id: "inbox", name: "Inbox" }] });
		await loadTwo;
		pending["folder:one:Receipts"]({
			data: { id: "receipts", name: "Receipts" },
		});
		await made;
		expect(store.folders.map((f) => f.id)).toEqual(["inbox"]);
	});
});
