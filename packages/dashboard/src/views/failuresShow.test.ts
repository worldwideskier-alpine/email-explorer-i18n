import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick } from "vue";
import { createI18n } from "vue-i18n";
import { createMemoryHistory, createRouter, RouterView } from "vue-router";
import { englishWith } from "@/testing/english";

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

const push = vi.hoisted(() => ({
	supported: false,
	subscribe: async () => {},
}));
vi.mock("@/services/push", async (actual) => ({
	PushPermissionDenied: ((await actual()) as { PushPermissionDenied: unknown })
		.PushPermissionDenied,
	isPushSupported: () => push.supported,
	getExistingSubscription: async () => null,
	subscribeToPush: () => push.subscribe(),
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
	i18n.global.setLocaleMessage("en", englishWith(messages.en) as never);
	i18n.global.locale.value = "en" as never;
	// Navigate before the router is installed; installed first, it resolved
	// the memory history's empty start, matched nothing and warned.
	await router.push(path);
	await router.isReady();
	app.use(pinia).use(router).use(i18n);
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

	// The name and signature's save said nothing when it worked, so it could
	// not be told from one that had not been pressed.
	it("says so when the name and signature are saved", async () => {
		updateMailbox.mockImplementation(async () => ({
			data: structuredClone(stored),
		}));
		await mountSettings();
		const form = (host.querySelector("#name") as HTMLElement).closest(
			"form",
		) as HTMLFormElement;
		const status = () => form.querySelector('[role="status"]')?.textContent;
		expect(status()).toBeUndefined();

		form.dispatchEvent(new Event("submit"));
		await settle();

		expect(updateMailbox).toHaveBeenCalledOnce();
		expect(status()).toBe("Saved.");
	});

	/**
	 * The name and signature arrive filled in, and counted as writing the
	 * whole time the screen was open: a session that ended here never went to
	 * sign-in, and a new build was never picked up.
	 */
	it("is writing only once the name or signature has been typed into", async () => {
		const { somethingIsBeingWritten } = await import("@/services/appUpdate");
		updateMailbox.mockImplementation(async () => ({
			data: structuredClone(stored),
		}));
		await mountSettings();
		// Loaded: a name in the box and a signature in the editor, as stored.
		expect((host.querySelector("#name") as HTMLInputElement).value).toBe(
			"Mine",
		);
		expect(
			host.querySelector('[contenteditable="true"]')?.textContent,
		).toContain("stored");
		expect(somethingIsBeingWritten(document)).toBe(false);

		const name = host.querySelector("#name") as HTMLInputElement;
		name.value = "Being typed";
		name.dispatchEvent(new Event("input", { bubbles: true }));
		await nextTick();
		expect(somethingIsBeingWritten(document)).toBe(true);

		(name.closest("form") as HTMLFormElement).dispatchEvent(
			new Event("submit"),
		);
		await settle();
		expect(updateMailbox).toHaveBeenCalledOnce();
		expect(somethingIsBeingWritten(document)).toBe(false);
	});

	it("says so when a save fails", async () => {
		updateMailbox.mockRejectedValue({ response: { status: 500, data: {} } });
		await mountSettings();

		await saveSpamPurge();

		expect(host.textContent).toContain("Could not save it.");
	});
});

/**
 * Turning either nightly job off. Each section's save sat inside the half
 * shown only while the switch was on, so turning the switch off hid the one
 * button that could store "off": the screen showed it off, nothing was sent,
 * and the purge went on deleting spam every night.
 */
describe("turning a nightly job off", () => {
	/** The settings section whose heading reads `heading`. */
	const sectionOf = (heading: string) =>
		[...host.querySelectorAll("div.border-t")].find((d) =>
			d.querySelector("h2")?.textContent?.includes(heading),
		) as HTMLElement;

	async function switchOffAndSave(heading: string) {
		const section = sectionOf(heading);
		expect(section, `the ${heading} section`).toBeTruthy();
		const toggle = section.querySelector(
			'input[type="checkbox"]',
		) as HTMLInputElement;
		expect(toggle.checked, "stored as on").toBe(true);
		toggle.click();
		await settle();
		expect(toggle.checked).toBe(false);
		const save = buttonIn(section, "Save");
		expect(save, "a save button while the switch is off").toBeTruthy();
		save.click();
		await settle();
	}

	beforeEach(() => {
		updateMailbox.mockImplementation(async (_id: string, sent: object) => ({
			data: {
				...structuredClone(stored),
				settings: { ...stored.settings, ...sent },
			},
		}));
	});

	afterEach(() => {
		stored.settings.autoBackup.enabled = false;
	});

	it("stores the spam purge as off", async () => {
		await mountSettings();
		await switchOffAndSave("Automatic spam deletion");
		expect(updateMailbox).toHaveBeenCalledOnce();
		expect(updateMailbox.mock.calls[0][1]).toMatchObject({
			spamRetention: { enabled: false },
		});
	});

	it("stores automatic backup as off", async () => {
		stored.settings.autoBackup.enabled = true;
		await mountSettings();
		await switchOffAndSave("Automatic backup");
		expect(updateMailbox).toHaveBeenCalledOnce();
		expect(updateMailbox.mock.calls[0][1]).toMatchObject({
			autoBackup: { enabled: false },
		});
	});
});

/**
 * A backup the nightly run did not reach. The run recorded it as an English
 * sentence, shown as it was in every language; it now says which reason it
 * is, and the screen words it.
 */
describe("a backup the nightly run did not reach", () => {
	afterEach(() => {
		stored.settings.autoBackup = {
			enabled: false,
			frequency: "daily",
			keep: 3,
		};
	});

	it("is said in the reader's language, not the run's English", async () => {
		stored.settings.autoBackup = {
			enabled: true,
			frequency: "daily",
			keep: 3,
			lastResult: {
				at: "2026-09-22T18:10:00.000Z",
				ok: false,
				error: "Not reached tonight: the pass ran out of time first.",
				reason: "not-reached",
			},
		} as never;
		await mountSettings();
		expect(host.textContent).toContain("the nightly run ran out of time first");
		expect(host.textContent).not.toContain("Not reached tonight");
	});
});

/**
 * Notifications the reader has blocked. The browser's refusal was shown as
 * its own English words; only the reader can undo it, so the screen says how,
 * in their language.
 */
describe("turning notifications on when the browser refuses", () => {
	afterEach(() => {
		push.supported = false;
		push.subscribe = async () => {};
	});

	it("says what to do, in the reader's language", async () => {
		const { PushPermissionDenied } =
			await vi.importActual<typeof import("@/services/push")>(
				"@/services/push",
			);
		push.supported = true;
		push.subscribe = async () => {
			throw new PushPermissionDenied();
		};
		await mountSettings();
		(host.querySelector('[role="switch"]') as HTMLButtonElement).click();
		await settle();
		expect(host.textContent).toContain(
			"Notifications are blocked for this site",
		);
		expect(host.textContent).not.toContain("permission was not granted");
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

		// The sidebar loads the mailbox's folders (Sidebar.vue); it is not
		// mounted here, so they are loaded the way it would.
		const { useFolderStore } = await import("@/stores/folders");
		await useFolderStore().fetchFolders("m@example.com");
		await settle();

		(host.querySelector('[title="Move to folder"]') as HTMLElement).click();
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
		expect(document.body.textContent).toContain(
			"That folder no longer exists.",
		);
	});
});
