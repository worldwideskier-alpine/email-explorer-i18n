import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, h, nextTick } from "vue";
import { createMemoryHistory, createRouter, RouterView } from "vue-router";
import { englishWith } from "@/testing/english";

/**
 * A search that could not be made, and a list of logins that could not be
 * read, each looked like an answer: "No results found", and a screen listing
 * no way at all to sign in. Mounted for real, as loadFailures.test.ts does
 * for the lists it covers.
 */

const searchEmails = vi.fn();
const listOwnLogins = vi.fn();

vi.mock("@/services/api", () => ({
	default: {
		searchEmails: (...a: unknown[]) => searchEmails(...a),
		listOwnLogins: (...a: unknown[]) => listOwnLogins(...a),
		adminGetResendSettings: vi.fn(async () => ({ data: { source: "none" } })),
		setAuthToken: vi.fn(),
		clearAuthToken: vi.fn(),
	},
}));

const LOAD_FAILED = "Could not load. Check your connection and try again.";

let host: HTMLElement;
let unmount = () => {};
beforeEach(() => {
	host = document.createElement("div");
	document.body.appendChild(host);
	searchEmails.mockReset();
	listOwnLogins.mockReset();
});
afterEach(() => {
	vi.restoreAllMocks();
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

async function mount(
	path: string,
	routes: Parameters<typeof createRouter>[0]["routes"],
	before?: () => Promise<void>,
) {
	const pinia = createPinia();
	setActivePinia(pinia);
	const router = createRouter({ history: createMemoryHistory(), routes });
	const app = createApp({ render: () => h(RouterView) });
	const { i18n } = await import("@/i18n");
	i18n.global.setLocaleMessage("en", englishWith() as never);
	i18n.global.locale.value = "en" as never;
	await router.push(path);
	await router.isReady();
	app.use(pinia).use(router).use(i18n);
	await before?.();
	app.mount(host);
	unmount = () => app.unmount();
	await settle();
}

const retry = () =>
	[...host.querySelectorAll("button")].find(
		(b) => b.textContent?.trim() === "Try again",
	) as HTMLButtonElement | undefined;

describe("a search that fails", () => {
	const blank = { render: () => h("div") };
	const mountResults = async () => {
		const { default: SearchResults } = await import("./SearchResults.vue");
		await mount(
			"/mailbox/m%40example.com/search?q=invoice",
			[
				{
					path: "/mailbox/:mailboxId/search",
					name: "SearchResults",
					component: SearchResults,
				},
				{
					path: "/mailbox/:mailboxId/email/:id",
					name: "EmailDetail",
					component: blank,
				},
			],
			async () => {
				const { useSearchStore } = await import("@/stores/search");
				// As the header does it: fired, and not waited on.
				void useSearchStore().searchEmails("m@example.com", "invoice");
			},
		);
	};

	it("says it failed, not that nothing was found", async () => {
		searchEmails.mockRejectedValue({ response: { status: 500 } });
		await mountResults();

		expect(host.querySelector('[role="alert"]')?.textContent).toContain(
			LOAD_FAILED,
		);
		expect(host.textContent).not.toContain("No results found.");
	});

	it("asks the same question again when told to", async () => {
		searchEmails.mockRejectedValue({ response: { status: 500 } });
		await mountResults();

		searchEmails.mockResolvedValue({
			data: [
				{
					id: "e1",
					subject: "Your invoice",
					sender: "a@example.net",
					date: "2026-09-01T00:00:00.000Z",
				},
			],
		});
		retry()?.click();
		await settle();

		expect(searchEmails).toHaveBeenLastCalledWith("m@example.com", {
			query: "invoice",
		});
		expect(host.textContent).not.toContain(LOAD_FAILED);
		expect(host.textContent).toContain("Your invoice");
	});

	it("still says nothing was found when nothing was", async () => {
		searchEmails.mockResolvedValue({ data: [] });
		await mountResults();
		expect(host.textContent).toContain("No results found.");
		expect(host.textContent).not.toContain(LOAD_FAILED);
	});
});

describe("your logins, when they cannot be loaded", () => {
	const mountAdmin = async () => {
		const { default: Admin } = await import("./Admin.vue");
		await mount("/admin", [
			{ path: "/admin", name: "Admin", component: Admin },
			{ path: "/:rest(.*)*", component: { render: () => h("div") } },
		]);
	};

	it("say so, rather than listing none", async () => {
		// The screen logs the failure as well; expected here, and not noise.
		vi.spyOn(console, "error").mockImplementation(() => {});
		listOwnLogins.mockRejectedValue({ response: { status: 500 } });
		await mountAdmin();

		const users = [...host.querySelectorAll("h2")].find((h) =>
			h.textContent?.includes("Addresses you sign in with"),
		)?.parentElement?.parentElement as HTMLElement;
		expect(users, "the logins card").toBeTruthy();
		expect(users.querySelector('[role="alert"]')?.textContent).toContain(
			LOAD_FAILED,
		);

		listOwnLogins.mockResolvedValue({
			data: [{ id: "l1", email: "me@example.com", createdAt: 0 }],
		});
		retry()?.click();
		await settle();
		expect(users.textContent).not.toContain(LOAD_FAILED);
		expect(users.textContent).toContain("me@example.com");
	});
});
