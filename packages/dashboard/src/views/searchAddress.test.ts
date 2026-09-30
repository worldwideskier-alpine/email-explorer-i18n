import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, h, nextTick } from "vue";
import {
	createMemoryHistory,
	createRouter,
	type Router,
	RouterView,
} from "vue-router";
import { englishWith } from "@/testing/english";

/**
 * The results screen searches by its address. The words used to be held in
 * the store alone, so a reload, a shared link or the back button showed
 * "No results found" for a search that had never been made.
 */

const searchEmails = vi.fn();

vi.mock("@/services/api", () => ({
	default: {
		searchEmails: (...a: unknown[]) => searchEmails(...a),
		setAuthToken: vi.fn(),
		clearAuthToken: vi.fn(),
	},
}));

const FOUND = {
	data: [
		{
			id: "e1",
			subject: "Your invoice",
			sender: "a@example.net",
			date: "2026-09-01T00:00:00.000Z",
		},
	],
};

let host: HTMLElement;
let router: Router;
let unmount = () => {};
beforeEach(() => {
	host = document.createElement("div");
	document.body.appendChild(host);
	searchEmails.mockReset();
});
afterEach(() => {
	unmount();
	host.remove();
	document.body.innerHTML = "";
});

const settle = async () => {
	for (let i = 0; i < 6; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await nextTick();
	}
};

async function open(path: string) {
	const { default: SearchResults } = await import("./SearchResults.vue");
	const blank = { render: () => h("div") };
	const pinia = createPinia();
	setActivePinia(pinia);
	router = createRouter({
		history: createMemoryHistory(),
		routes: [
			{
				path: "/mailbox/:mailboxId/search",
				name: "SearchResults",
				component: SearchResults,
			},
			{
				path: "/mailbox/:mailboxId/:folder",
				name: "EmailList",
				component: blank,
			},
			{
				path: "/mailbox/:mailboxId/email/:id",
				name: "EmailDetail",
				component: blank,
			},
		],
	});
	const app = createApp({ render: () => h(RouterView) });
	const { i18n } = await import("@/i18n");
	i18n.global.setLocaleMessage("en", englishWith() as never);
	i18n.global.locale.value = "en" as never;
	await router.push(path);
	await router.isReady();
	app.use(pinia).use(router).use(i18n);
	app.mount(host);
	unmount = () => app.unmount();
	await settle();
}

describe("the search results screen, opened from its address", () => {
	it("makes the search the address names", async () => {
		searchEmails.mockResolvedValue(FOUND);
		await open("/mailbox/m%40example.com/search?q=invoice");

		expect(searchEmails).toHaveBeenCalledWith("m@example.com", {
			query: "invoice",
		});
		expect(host.textContent).toContain("Your invoice");
		expect(host.textContent).not.toContain("No results found.");
	});

	it("searches again when the words in the address change", async () => {
		searchEmails.mockResolvedValue({ data: [] });
		await open("/mailbox/m%40example.com/search?q=invoice");

		searchEmails.mockResolvedValue(FOUND);
		await router.push("/mailbox/m%40example.com/search?q=receipt");
		await settle();

		expect(searchEmails).toHaveBeenLastCalledWith("m@example.com", {
			query: "receipt",
		});
		expect(host.textContent).toContain("Your invoice");
	});

	it("goes to the mailbox when nothing is asked", async () => {
		await open("/mailbox/m%40example.com/search");

		expect(searchEmails).not.toHaveBeenCalled();
		expect(router.currentRoute.value.name).toBe("EmailList");
		expect(router.currentRoute.value.params).toMatchObject({
			mailboxId: "m@example.com",
			folder: "inbox",
		});
	});
});

describe("the header's search box", () => {
	it("puts the words in the address", async () => {
		searchEmails.mockResolvedValue(FOUND);
		const { default: Header } = await import("@/components/Header.vue");
		await open("/mailbox/m%40example.com/inbox");
		const app = createApp({ render: () => h(Header) });
		const { i18n } = await import("@/i18n");
		const pinia = createPinia();
		app.use(pinia).use(router).use(i18n);
		const bar = document.createElement("div");
		document.body.appendChild(bar);
		app.mount(bar);

		const box = bar.querySelector("input") as HTMLInputElement;
		box.value = "invoice";
		box.dispatchEvent(new Event("input"));
		box.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter" }));
		await settle();

		expect(router.currentRoute.value.name).toBe("SearchResults");
		expect(router.currentRoute.value.query).toEqual({ q: "invoice" });
		app.unmount();
	});
});
