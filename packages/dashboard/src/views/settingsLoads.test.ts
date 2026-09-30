import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, h, nextTick } from "vue";
import { createMemoryHistory, createRouter, RouterView } from "vue-router";
import { englishWith } from "@/testing/english";

/**
 * The settings screen, mounted for real, for what it shows while it loads
 * and when loading fails -- and for what a download holds open while it runs.
 *
 * Each of these used to look like something else: a mailbox that could not be
 * loaded was a blank page, a list of backups that could not be read said
 * there were none, the list vanished when automatic backup was switched off
 * although the archives were still there, and the fields were filled from the
 * mailbox as it had been loaded earlier, so a save wrote the old values back.
 */

const stored = () => ({
	id: "m@example.com",
	email: "m@example.com",
	name: "Now",
	settings: {
		fromName: "Now",
		signature: { enabled: false, html: "" },
		autoBackup: { enabled: false, frequency: "daily", keep: 3 },
	},
});

const getMailbox = vi.fn();
const listBackups = vi.fn();
const updateMailbox = vi.fn();
const exportMailbox = vi.fn();
const downloadBackup = vi.fn();

vi.mock("@/services/api", () => ({
	default: {
		getMailbox: (...a: unknown[]) => getMailbox(...a),
		listBackups: (...a: unknown[]) => listBackups(...a),
		updateMailbox: (...a: unknown[]) => updateMailbox(...a),
		exportMailbox: (...a: unknown[]) => exportMailbox(...a),
		downloadBackup: (...a: unknown[]) => downloadBackup(...a),
		setAuthToken: vi.fn(),
		clearAuthToken: vi.fn(),
	},
}));

vi.mock("@/services/push", () => ({
	PushPermissionDenied: class extends Error {},
	isPushSupported: () => false,
	getExistingSubscription: async () => null,
	subscribeToPush: async () => {},
	unsubscribeFromPush: async () => {},
}));

const LOAD_FAILED = "Could not load. Check your connection and try again.";

let host: HTMLElement;
let unmount = () => {};

beforeEach(() => {
	host = document.createElement("div");
	document.body.appendChild(host);
	for (const fn of [
		getMailbox,
		listBackups,
		updateMailbox,
		exportMailbox,
		downloadBackup,
	]) {
		fn.mockReset();
	}
	getMailbox.mockImplementation(async () => ({ data: stored() }));
	listBackups.mockImplementation(async () => ({ data: [] }));
});

afterEach(() => {
	unmount();
	host.remove();
	document.body.innerHTML = "";
	vi.unstubAllGlobals();
});

const settle = async () => {
	for (let i = 0; i < 6; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await nextTick();
	}
};

async function mountSettings(before?: () => Promise<void>) {
	const pinia = createPinia();
	setActivePinia(pinia);
	await before?.();
	const { default: Settings } = await import("./Settings.vue");
	const router = createRouter({
		history: createMemoryHistory(),
		routes: [
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
		],
	});
	const app = createApp({ render: () => h(RouterView) });
	const { i18n } = await import("@/i18n");
	i18n.global.setLocaleMessage("en", englishWith() as never);
	i18n.global.locale.value = "en" as never;
	await router.push("/mailbox/m%40example.com/settings");
	await router.isReady();
	app.use(pinia).use(router).use(i18n);
	app.mount(host);
	unmount = () => app.unmount();
	await settle();
}

const button = (text: string) =>
	[...host.querySelectorAll("button")].find(
		(b) => b.textContent?.trim() === text,
	) as HTMLButtonElement | undefined;

describe("a mailbox that cannot be loaded", () => {
	it("says so, with a way to try again, instead of a blank page", async () => {
		getMailbox.mockRejectedValue({ response: { status: 500 } });
		await mountSettings();

		expect(host.querySelector('[role="alert"]')?.textContent).toContain(
			LOAD_FAILED,
		);
		expect(host.querySelector("#name")).toBeNull();

		getMailbox.mockImplementation(async () => ({ data: stored() }));
		button("Try again")?.click();
		await settle();

		expect(host.textContent).not.toContain(LOAD_FAILED);
		expect((host.querySelector("#name") as HTMLInputElement).value).toBe("Now");
	});
});

describe("the fields", () => {
	/**
	 * Opened from the same mailbox's inbox, the store still held the mailbox
	 * as loaded then. The fields were filled from that, and the answer to
	 * this screen's own request -- the same id -- was never put in them.
	 */
	it("are filled from this screen's answer, not the mailbox loaded before", async () => {
		updateMailbox.mockImplementation(async () => ({ data: stored() }));
		await mountSettings(async () => {
			const { useMailboxStore } = await import("@/stores/mailboxes");
			const before = stored();
			before.name = "Before";
			before.settings.fromName = "Before";
			useMailboxStore().currentMailbox = before as never;
		});

		const name = host.querySelector("#name") as HTMLInputElement;
		expect(name.value).toBe("Now");

		(name.closest("form") as HTMLFormElement).dispatchEvent(
			new Event("submit"),
		);
		await settle();
		expect(updateMailbox).toHaveBeenCalledOnce();
		expect(updateMailbox.mock.calls[0][1]).toMatchObject({ fromName: "Now" });
	});
});

describe("the stored backups", () => {
	const archive = { name: "daily-2026-09-01.mbox", at: "", size: 2048 };

	/** The switch decides whether new ones are made, not whether old ones exist. */
	it("are listed with automatic backup switched off", async () => {
		listBackups.mockImplementation(async () => ({ data: [archive] }));
		await mountSettings();

		expect(host.textContent).toContain(archive.name);
		expect(button("Download")).toBeTruthy();
		expect(host.textContent).not.toContain("No backups stored yet.");
	});

	it("that could not be listed are not said to be none", async () => {
		listBackups.mockRejectedValue({ response: { status: 500 } });
		await mountSettings();

		expect(host.textContent).toContain(LOAD_FAILED);
		expect(host.textContent).not.toContain("No backups stored yet.");

		listBackups.mockImplementation(async () => ({ data: [archive] }));
		button("Try again")?.click();
		await settle();
		expect(host.textContent).not.toContain(LOAD_FAILED);
		expect(host.textContent).toContain(archive.name);
	});
});

/**
 * A download shows in no field, so nothing kept a new build from reloading
 * the page in the middle of one -- which cut it off.
 */
describe("a download in progress", () => {
	// jsdom has neither, and cannot follow the link to a file.
	beforeEach(() => {
		Object.assign(URL, {
			createObjectURL: () => "blob:held",
			revokeObjectURL: () => {},
		});
		vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
	});
	afterEach(() => {
		vi.restoreAllMocks();
		const url = URL as unknown as Record<string, unknown>;
		delete url.createObjectURL;
		delete url.revokeObjectURL;
	});

	async function holdsUntilDone(start: () => void, finish: () => void) {
		const { somethingIsBeingWritten } = await import("@/services/appUpdate");
		expect(somethingIsBeingWritten(document), "before").toBe(false);
		start();
		await settle();
		expect(somethingIsBeingWritten(document), "while it runs").toBe(true);
		finish();
		// The object URL is let go a second later; see saveBlob.
		await new Promise((resolve) => setTimeout(resolve, 1100));
		await settle();
		expect(somethingIsBeingWritten(document), "once it is done").toBe(false);
	}

	it("holds the page for an export", async () => {
		let answer: (v: unknown) => void = () => {};
		exportMailbox.mockImplementation(
			() => new Promise((resolve) => (answer = resolve)),
		);
		await mountSettings();
		await holdsUntilDone(
			() => button("Download as mbox")?.click(),
			() => answer({ data: new Blob(["x"]) }),
		);
		expect(exportMailbox).toHaveBeenCalledOnce();
	});

	it("holds the page for a stored backup", async () => {
		listBackups.mockImplementation(async () => ({
			data: [{ name: "daily-2026-09-01.mbox", at: "", size: 1 }],
		}));
		let answer: (v: unknown) => void = () => {};
		downloadBackup.mockImplementation(
			() => new Promise((resolve) => (answer = resolve)),
		);
		await mountSettings();
		await holdsUntilDone(
			() => button("Download")?.click(),
			() => answer({ data: new Blob(["x"]) }),
		);
		expect(downloadBackup).toHaveBeenCalledOnce();
	});

	it("lets go of the page when the download fails", async () => {
		const { somethingIsBeingWritten } = await import("@/services/appUpdate");
		vi.stubGlobal("alert", () => {});
		exportMailbox.mockRejectedValue({ response: { status: 500 } });
		await mountSettings();
		button("Download as mbox")?.click();
		await settle();
		expect(exportMailbox).toHaveBeenCalledOnce();
		expect(somethingIsBeingWritten(document)).toBe(false);
	});
});
