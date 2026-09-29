import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, h, nextTick } from "vue";
import { createMemoryHistory, createRouter, RouterView } from "vue-router";
import { englishWith } from "@/testing/english";

/**
 * A list that could not be loaded is not an empty one.
 *
 * Home, the contacts and the message list fired their loads and forgot them:
 * a failure was an unhandled rejection, and the screen went on showing what
 * it shows for nothing at all -- "No mailboxes found" with the set-up
 * instructions, an empty contact list, "This folder is empty". A failed
 * switch of folder was worse: the previous folder's rows stayed, under the
 * new folder's name.
 */

const listMailboxes = vi.fn();
const listContacts = vi.fn();
const listEmails = vi.fn();

vi.mock("@/services/api", () => ({
	default: {
		listMailboxes: (...a: unknown[]) => listMailboxes(...a),
		listContacts: (...a: unknown[]) => listContacts(...a),
		listEmails: (...a: unknown[]) => listEmails(...a),
		listFolders: vi.fn(async () => ({ data: [] })),
		getAppSettings: vi.fn(async () => ({ data: {} })),
		setAuthToken: vi.fn(),
		clearAuthToken: vi.fn(),
	},
}));

// jsdom has none; the list uses it only to load more on scroll.
vi.stubGlobal(
	"IntersectionObserver",
	class {
		observe() {}
		unobserve() {}
		disconnect() {}
	},
);

const LOAD_FAILED = "Could not load. Check your connection and try again.";

let host: HTMLElement;
let unmount = () => {};
beforeEach(() => {
	host = document.createElement("div");
	document.body.appendChild(host);
	for (const fn of [listMailboxes, listContacts, listEmails]) fn.mockReset();
});
afterEach(() => {
	unmount();
	host.remove();
	document.body.innerHTML = "";
});

const settle = async () => {
	for (let i = 0; i < 6; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await nextTick();
	}
};

async function mount(
	path: string,
	routes: Parameters<typeof createRouter>[0]["routes"],
) {
	const pinia = createPinia();
	setActivePinia(pinia);
	const router = createRouter({ history: createMemoryHistory(), routes });
	const { i18n } = await import("@/i18n");
	i18n.global.setLocaleMessage("en", englishWith({}) as never);
	i18n.global.locale.value = "en" as never;
	const app = createApp({ render: () => h(RouterView) });
	await router.push(path);
	await router.isReady();
	app.use(pinia).use(router).use(i18n);
	app.mount(host);
	unmount = () => app.unmount();
	await settle();
	return router;
}

const retry = () =>
	[...host.querySelectorAll("button")].find(
		(b) => b.textContent?.trim() === "Try again",
	) as HTMLButtonElement | undefined;

describe("home", () => {
	const mountHome = async () => {
		const { default: Home } = await import("./Home.vue");
		return mount("/", [
			{ path: "/", component: Home },
			{
				path: "/mailbox/:mailboxId",
				name: "Mailbox",
				component: { render: () => h("div") },
			},
			{ path: "/:rest(.*)*", component: { render: () => h("div") } },
		]);
	};

	it("says it could not load, not that there are no mailboxes", async () => {
		listMailboxes.mockRejectedValue(new Error("offline"));
		await mountHome();
		expect(host.textContent).toContain(LOAD_FAILED);
		expect(host.textContent).not.toContain("No mailboxes found");
	});

	it("tries again when asked, and shows what came back", async () => {
		listMailboxes.mockRejectedValueOnce(new Error("offline"));
		listMailboxes.mockResolvedValue({
			data: [{ id: "m@example.com", name: "Mine", email: "m@example.com" }],
		});
		await mountHome();
		retry()?.click();
		await settle();
		expect(listMailboxes).toHaveBeenCalledTimes(2);
		expect(host.textContent).toContain("Mine");
		expect(host.textContent).not.toContain(LOAD_FAILED);
	});

	it("still says there are none when there are none", async () => {
		listMailboxes.mockResolvedValue({ data: [] });
		await mountHome();
		expect(host.textContent).toContain("No mailboxes found");
		expect(host.textContent).not.toContain(LOAD_FAILED);
	});
});

describe("the contacts", () => {
	it("say they could not be loaded", async () => {
		listContacts.mockRejectedValue(new Error("offline"));
		const { default: Contacts } = await import("./Contacts.vue");
		await mount("/mailbox/m%40example.com/contacts", [
			{ path: "/mailbox/:mailboxId/contacts", component: Contacts },
		]);
		expect(host.textContent).toContain(LOAD_FAILED);
		expect(retry()).toBeTruthy();
	});
});

describe("the message list", () => {
	const mountList = async (folder: string) => {
		const { default: EmailList } = await import("./EmailList.vue");
		return mount(`/mailbox/m%40example.com/emails/${folder}`, [
			{
				path: "/mailbox/:mailboxId/emails/:folder",
				name: "EmailList",
				component: EmailList,
			},
			{
				path: "/mailbox/:mailboxId/email/:id",
				name: "EmailDetail",
				component: { render: () => h("div") },
			},
		]);
	};

	it("says it could not load, not that the folder is empty", async () => {
		listEmails.mockRejectedValue(new Error("offline"));
		await mountList("inbox");
		expect(host.textContent).toContain(LOAD_FAILED);
		expect(host.textContent).not.toContain("This folder is empty");
	});

	it("does not keep the last folder's messages under the next one's name", async () => {
		listEmails.mockResolvedValueOnce({
			data: [
				{
					id: "e1",
					subject: "From the inbox",
					sender: "a@example.org",
					date: "2026-09-01T00:00:00.000Z",
					read: true,
					starred: false,
					folder_id: "inbox",
				},
			],
		});
		const router = await mountList("inbox");
		expect(host.textContent).toContain("From the inbox");

		listEmails.mockRejectedValue(new Error("offline"));
		await router.push("/mailbox/m%40example.com/emails/trash");
		await settle();
		expect(host.textContent).toContain("Trash");
		expect(host.textContent).not.toContain("From the inbox");
		expect(host.textContent).toContain(LOAD_FAILED);
	});
});
