import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick } from "vue";
import { createI18n } from "vue-i18n";
import { createMemoryHistory, createRouter, RouterView } from "vue-router";

/**
 * Screens mounted for real, for what a failure or a save does to them: a
 * save that fails says so, a save of one section leaves the others alone,
 * and a move that fails does not pretend it worked.
 */

const stored = {
	id: "m@example.com",
	email: "m@example.com",
	name: "Mine",
	settings: {
		fromName: "Mine",
		signature: { enabled: true, html: "<p>stored</p>" },
		spamRetention: { enabled: true, days: 30 },
		autoBackup: { enabled: false, frequency: "daily", keep: 3 },
	},
};

const updateMailbox = vi.fn();
const moveEmail = vi.fn();
const getEmail = vi.fn();

vi.mock("@/services/api", () => ({
	default: {
		getMailbox: vi.fn(async () => ({ data: structuredClone(stored) })),
		updateMailbox: (...args: unknown[]) => updateMailbox(...args),
		listBackups: vi.fn(async () => ({ data: [] })),
		getEmail: (...args: unknown[]) => getEmail(...args),
		moveEmail: (...args: unknown[]) => moveEmail(...args),
		listFolders: vi.fn(async () => ({
			data: [
				{ id: "inbox", name: "Inbox" },
				{ id: "archive", name: "Archive" },
			],
		})),
		updateEmail: vi.fn(async () => ({ data: {} })),
		setAuthToken: vi.fn(),
		clearAuthToken: vi.fn(),
	},
}));

vi.mock("@/services/push", () => ({
	isPushSupported: () => false,
	getExistingSubscription: async () => null,
	subscribeToPush: async () => {},
	unsubscribeFromPush: async () => {},
}));

vi.mock("@/components/EmailIframe.vue", () => ({
	default: defineComponent({ render: () => h("div") }),
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

const messages = {
	en: {
		admin: { resend: { failed: "Could not save it." } },
		compose: { unexpectedError: "An unexpected error occurred." },
		settings: { spamPurgeSaved: "Saved." },
		apiErrors: {},
	},
};

let host: HTMLElement;
let unmount: () => void = () => {};

beforeEach(() => {
	host = document.createElement("div");
	document.body.appendChild(host);
	updateMailbox.mockReset();
	moveEmail.mockReset();
	getEmail.mockReset();
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

async function mount(
	path: string,
	routes: Parameters<typeof createRouter>[0]["routes"],
) {
	const pinia = createPinia();
	setActivePinia(pinia);
	const router = createRouter({ history: createMemoryHistory(), routes });
	const { default: Toast } = await import("@/components/Toast.vue");
	const app = createApp({ render: () => [h(RouterView), h(Toast)] });
	const { i18n } = await import("@/i18n");
	i18n.global.setLocaleMessage("en", messages.en as never);
	i18n.global.locale.value = "en" as never;
	app.use(pinia).use(router).use(i18n);
	await router.push(path);
	await router.isReady();
	app.mount(host);
	unmount = () => app.unmount();
	await settle();
	return router;
}

const mountSettings = async () => {
	const { default: Settings } = await import("./Settings.vue");
	return mount("/mailbox/m%40example.com/settings", [
		{
			path: "/mailbox/:mailboxId/settings",
			name: "Settings",
			component: Settings,
		},
		{
			path: "/:rest(.*)*",
			name: "Home",
			component: { render: () => h("div") },
		},
	]);
};

const buttonIn = (section: Element, text?: string) =>
	[...section.querySelectorAll("button")].find(
		(b) => !text || b.textContent?.includes(text),
	) as HTMLButtonElement;

describe("the settings screen", () => {
	/**
	 * The spam purge's save used to send every section as the screen had
	 * loaded it, and then reload every field from the answer -- so a signature
	 * being written was replaced by the stored one.
	 */
	it("saves one section, and leaves the others as they are being edited", async () => {
		updateMailbox.mockImplementation(async (_id: string, sent: object) => ({
			data: {
				...structuredClone(stored),
				settings: { ...stored.settings, ...sent },
			},
		}));
		await mountSettings();

		const name = host.querySelector("#name") as HTMLInputElement;
		name.value = "Being typed";
		name.dispatchEvent(new Event("input"));
		await nextTick();

		await saveSpamPurge();

		expect(updateMailbox).toHaveBeenCalledOnce();
		expect(Object.keys(updateMailbox.mock.calls[0][1])).toEqual([
			"spamRetention",
		]);
		expect((host.querySelector("#name") as HTMLInputElement).value).toBe(
			"Being typed",
		);
	});

	it("says so when a save fails", async () => {
		updateMailbox.mockRejectedValue({ response: { status: 500, data: {} } });
		await mountSettings();

		await saveSpamPurge();

		expect(host.textContent).toContain("Could not save it.");
	});
});

/** The spam purge section's own save button: the one beside its field. */
async function saveSpamPurge() {
	const field = host.querySelector("#spamPurgeDays");
	expect(field, "the spam purge section is open").toBeTruthy();
	const button = field
		?.closest("div.mt-4")
		?.querySelector("button") as HTMLButtonElement | null;
	expect(button).toBeTruthy();
	button?.click();
	await settle();
}

describe("moving an open message", () => {
	/**
	 * The move used to be fired and forgotten: the screen went back to the
	 * list, the message stayed where it was, and nothing said so.
	 */
	it("stays on the message and says so when the move fails", async () => {
		getEmail.mockResolvedValue({
			data: {
				id: "e1",
				subject: "s",
				sender: "a@example.org",
				recipient: "m@example.com",
				date: "2026-09-01T00:00:00.000Z",
				read: true,
				starred: false,
				folder_id: "inbox",
				body: "<p>x</p>",
				attachments: [],
			},
		});
		moveEmail.mockRejectedValue({
			response: { status: 400, data: { error: "Folder not found" } },
		});
		const { default: EmailDetail } = await import("./EmailDetail.vue");
		const blank = { render: () => h("div") };
		const router = await mount(
			"/mailbox/m%40example.com/email/e1?fromFolder=inbox",
			[
				{
					path: "/mailbox/:mailboxId/email/:id",
					name: "EmailDetail",
					component: EmailDetail,
				},
				{
					path: "/mailbox/:mailboxId/emails/:folder",
					name: "EmailList",
					component: blank,
				},
				{
					path: "/mailbox/:mailboxId/email/:id/source",
					name: "EmailSource",
					component: blank,
				},
			],
		);

		(
			host.querySelector('[title="emailDetail.moveToFolder"]') as HTMLElement
		).click();
		await settle();
		const archive = [...host.querySelectorAll("button")].find(
			(b) => b.textContent?.trim() === "Archive",
		);
		expect(archive, "Archive in the move menu").toBeTruthy();
		archive?.click();
		await settle();

		expect(moveEmail).toHaveBeenCalledOnce();
		expect(router.currentRoute.value.name).toBe("EmailDetail");
		// The server's words, through the catalogue, in a toast.
		expect(document.body.textContent).toContain("Folder not found");
	});
});
