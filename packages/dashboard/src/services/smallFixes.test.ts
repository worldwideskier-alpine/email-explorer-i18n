import { createPinia, setActivePinia } from "pinia";
import { describe, expect, it, vi } from "vitest";
import { createApp, h, nextTick } from "vue";
import { englishWith } from "@/testing/english";

vi.mock("@/services/api", () => ({
	default: {
		logout: vi.fn(async () => ({})),
		clearAuthToken: vi.fn(),
		setAuthToken: vi.fn(),
	},
}));

const swSource = Object.values(
	import.meta.glob("../../public/sw.js", {
		query: "?raw",
		import: "default",
		eager: true,
	}) as Record<string, string>,
)[0];

/** Runs the service worker's script against a stand-in for its global. */
function serviceWorkerWith(tabs: { url: string }[]) {
	const listeners: Record<string, (event: unknown) => void> = {};
	const log: string[] = [];
	const clients = tabs.map((tab) => ({
		url: tab.url,
		focus: async () => log.push(`focus ${tab.url}`),
		navigate: async (url: string) => log.push(`navigate ${tab.url} -> ${url}`),
		postMessage: (message: { type: string; url: string }) =>
			log.push(`message ${tab.url} ${message.type} ${message.url}`),
	}));
	const self = {
		location: { origin: "https://mail.example.test" },
		addEventListener: (name: string, fn: (event: unknown) => void) => {
			listeners[name] = fn;
		},
		skipWaiting: () => {},
		clients: {
			claim: async () => {},
			matchAll: async () => clients,
			openWindow: async (url: string) => log.push(`open ${url}`),
		},
		registration: {},
	};
	new Function("self", swSource)(self);
	return {
		log,
		async click(url: string) {
			let done: Promise<unknown> = Promise.resolve();
			listeners.notificationclick({
				notification: { close: () => {}, data: { url } },
				waitUntil: (p: Promise<unknown>) => {
					done = p;
				},
			});
			await done;
		},
	};
}

describe("tapping a notification", () => {
	/**
	 * It used to navigate the first tab from the service worker: a reload,
	 * which threw away a message being written there -- and a rejection for a
	 * tab the worker did not control, so the tab came forward and stayed put.
	 */
	it("asks an open tab to go there itself", async () => {
		const sw = serviceWorkerWith([
			{ url: "https://mail.example.test/mailbox/m%40x/emails/inbox" },
		]);
		await sw.click("/mailbox/m%40x/email/e1?fromFolder=inbox");
		expect(sw.log).toEqual([
			"message https://mail.example.test/mailbox/m%40x/emails/inbox open /mailbox/m%40x/email/e1?fromFolder=inbox",
			"focus https://mail.example.test/mailbox/m%40x/emails/inbox",
		]);
	});

	it("only brings forward a tab already showing that message", async () => {
		const sw = serviceWorkerWith([
			{ url: "https://mail.example.test/mailbox/m%40x/emails/inbox" },
			{
				url: "https://mail.example.test/mailbox/m%40x/email/e1?fromFolder=inbox",
			},
		]);
		await sw.click("/mailbox/m%40x/email/e1?fromFolder=inbox");
		expect(sw.log).toEqual([
			"focus https://mail.example.test/mailbox/m%40x/email/e1?fromFolder=inbox",
		]);
	});

	it("opens a tab when there is none, and nothing off this site", async () => {
		const sw = serviceWorkerWith([]);
		await sw.click("/mailbox/m%40x/email/e1");
		await sw.click("https://elsewhere.example/phish");
		expect(sw.log).toEqual(["open /mailbox/m%40x/email/e1"]);
	});
});

describe("two toasts in the same moment", () => {
	/** Ids were the clock, so one's timeout took both. */
	it("each have their own id", async () => {
		const { useToast } = await import("@/composables/useToast");
		const { addToast, toasts, removeToast } = useToast();
		const now = vi.spyOn(Date, "now").mockReturnValue(1000);
		const a = addToast("a", "info", 0);
		const b = addToast("b", "info", 0);
		now.mockRestore();
		expect(a).not.toBe(b);
		removeToast(a);
		expect(toasts.value.map((t) => t.message)).toEqual(["b"]);
		removeToast(b);
	});
});

describe("signing out", () => {
	/**
	 * The stores outlive the session in the tab, and the next person to sign
	 * in there saw the last one's search results and open mailbox.
	 */
	it("forgets what the person had open", async () => {
		setActivePinia(createPinia());
		const { useSearchStore } = await import("@/stores/search");
		const { useMailboxStore } = await import("@/stores/mailboxes");
		const { useEmailStore } = await import("@/stores/emails");
		const { useAuthStore } = await import("@/stores/auth");
		useSearchStore().results = [{ id: "theirs" }] as never;
		useSearchStore().mailboxId = "theirs@example.com";
		useMailboxStore().currentMailbox = { id: "theirs@example.com" } as never;
		useEmailStore().emails = [{ id: "e" }] as never;
		// And the sidebar's folders, the contacts and an open composer, which
		// used to stay: the next person saw the last one's folder names.
		const { useFolderStore } = await import("@/stores/folders");
		const { useContactStore } = await import("@/stores/contacts");
		const { useUIStore } = await import("@/stores/ui");
		useFolderStore().folders = [{ id: "f", name: "Their folder" }] as never;
		useContactStore().contacts = [{ id: "c" }] as never;
		useUIStore().openComposeModal({
			mode: "reply",
			originalEmail: { id: "theirs" },
		});

		await useAuthStore().logout();

		expect(useFolderStore().folders).toEqual([]);
		expect(useContactStore().contacts).toEqual([]);
		expect(useUIStore().isComposeModalOpen).toBe(false);
		expect(useUIStore().composeOptions.originalEmail).toBeNull();

		expect(useSearchStore().results).toEqual([]);
		expect(useSearchStore().mailboxId).toBe("");
		expect(useMailboxStore().currentMailbox).toBeNull();
		expect(useEmailStore().emails).toEqual([]);
	});
});

describe("choosing a language that does not load", () => {
	/**
	 * The control shows the choice the moment it is made; with the catalogue
	 * failing, it went on naming a language the page was not in.
	 */
	it("puts the control back to the language on screen", async () => {
		const i18nModule = await import("@/i18n");
		vi.spyOn(i18nModule, "setLocale").mockRejectedValueOnce(
			new Error("offline"),
		);
		const { default: LanguageSwitcher } = await import(
			"@/components/LanguageSwitcher.vue"
		);
		const host = document.createElement("div");
		document.body.appendChild(host);
		const app = createApp({ render: () => h(LanguageSwitcher) });
		i18nModule.i18n.global.setLocaleMessage("en", englishWith() as never);
		app.use(i18nModule.i18n);
		app.mount(host);
		await nextTick();

		const select = host.querySelector("select") as HTMLSelectElement;
		const before = select.value;
		const other = [...select.options].find((o) => o.value !== before)?.value;
		select.value = other as string;
		select.dispatchEvent(new Event("change"));
		await new Promise((r) => setTimeout(r, 0));

		expect(select.value).toBe(before);
		app.unmount();
		host.remove();
	});
});

describe("search results", () => {
	/** From one mailbox, shown under another -- links to mail it does not have. */
	it("are shown only under the mailbox they came from", async () => {
		const { createMemoryHistory, createRouter, RouterView } = await import(
			"vue-router"
		);
		const { createI18n } = await import("vue-i18n");
		const pinia = createPinia();
		setActivePinia(pinia);
		const { default: SearchResults } = await import(
			"@/views/SearchResults.vue"
		);
		const router = createRouter({
			history: createMemoryHistory(),
			routes: [
				{ path: "/mailbox/:mailboxId/search", component: SearchResults },
				{
					path: "/mailbox/:mailboxId/email/:id",
					name: "EmailDetail",
					component: { render: () => h("div") },
				},
			],
		});
		const host = document.createElement("div");
		document.body.appendChild(host);
		const app = createApp({ render: () => h(RouterView) });
		// Navigate before the router is installed; installed first, it resolved
		// the memory history's empty start, matched nothing and warned.
		await router.push("/mailbox/two%40example.com/search");
		await router.isReady();
		app
			.use(pinia)
			.use(router)
			.use(
				createI18n({
					legacy: false,
					locale: "en",
					messages: { en: {} },
					missingWarn: false,
				}),
			);
		const { useSearchStore } = await import("@/stores/search");
		useSearchStore().mailboxId = "one@example.com";
		useSearchStore().results = [
			{ id: "r1", subject: "found", sender: "a@x", date: "2026-09-01" },
		] as never;

		app.mount(host);
		await nextTick();
		expect(host.textContent).not.toContain("found");

		await router.push("/mailbox/one%40example.com/search");
		await nextTick();
		expect(host.textContent).toContain("found");
		app.unmount();
		host.remove();
	});
});
