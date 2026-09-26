import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, h, nextTick } from "vue";
import { createMemoryHistory, createRouter, RouterView } from "vue-router";

/**
 * What a screen says after the server has answered: in the reader's
 * language, and about what actually happened.
 */

const resetPassword = vi.fn();
const createMailbox = vi.fn();
const listMailboxes = vi.fn();

vi.mock("@/services/api", () => ({
	default: {
		resetPassword: (...a: unknown[]) => resetPassword(...a),
		createMailbox: (...a: unknown[]) => createMailbox(...a),
		listMailboxes: (...a: unknown[]) => listMailboxes(...a),
		getAppSettings: vi.fn(async () => ({ data: {} })),
		setAuthToken: vi.fn(),
		clearAuthToken: vi.fn(),
	},
}));

let host: HTMLElement;
let unmount = () => {};
beforeEach(() => {
	host = document.createElement("div");
	document.body.appendChild(host);
	for (const fn of [resetPassword, createMailbox, listMailboxes])
		fn.mockReset();
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

async function mount(path: string, component: object, routePath: string) {
	const pinia = createPinia();
	setActivePinia(pinia);
	const router = createRouter({
		history: createMemoryHistory(),
		routes: [
			{ path: routePath, component },
			{ path: "/:rest(.*)*", component: { render: () => h("div") } },
		],
	});
	const { default: Toast } = await import("@/components/Toast.vue");
	const { i18n } = await import("@/i18n");
	i18n.global.setLocaleMessage("en", {
		apiErrors: {
			"Invalid or expired token": "That link has expired.",
			"Failed to create mailbox": "Failed to create mailbox",
		},
		home: { mailboxCreated: "Mailbox created." },
	} as never);
	i18n.global.locale.value = "en" as never;
	const app = createApp({ render: () => [h(RouterView), h(Toast)] });
	app.use(pinia).use(router).use(i18n);
	await router.push(path);
	await router.isReady();
	app.mount(host);
	unmount = () => app.unmount();
	await settle();
}

const type = (selector: string, value: string) => {
	const input = host.querySelector(selector) as HTMLInputElement;
	input.value = value;
	input.dispatchEvent(new Event("input"));
};

describe("the reset password screen", () => {
	/** The server answers in English; the catalogues had its sentences all along. */
	it("shows the server's refusal in the reader's language", async () => {
		resetPassword.mockRejectedValue({
			response: { status: 400, data: { error: "Invalid or expired token" } },
		});
		const { default: ResetPassword } = await import("./ResetPassword.vue");
		await mount("/reset-password?token=t", ResetPassword, "/reset-password");
		type("#password", "password123");
		type("#confirm-password", "password123");
		await nextTick();
		(host.querySelector("form") as HTMLFormElement).dispatchEvent(
			new Event("submit"),
		);
		await settle();

		expect(document.body.textContent).toContain("That link has expired.");
		expect(document.body.textContent).not.toContain("Invalid or expired token");
	});
});

describe("creating a mailbox", () => {
	/**
	 * Refreshing the list afterwards is not creating the mailbox. Its failure
	 * used to be reported as "Failed to create mailbox" about one that had
	 * been created.
	 */
	it("is not reported as failed when only the list could not be refreshed", async () => {
		listMailboxes.mockResolvedValueOnce({ data: [] });
		createMailbox.mockResolvedValue({ data: {} });
		const { default: Home } = await import("./Home.vue");
		await mount("/", Home, "/");
		listMailboxes.mockRejectedValue(new Error("offline"));

		const open = [...host.querySelectorAll("button")].find((b) =>
			b.textContent?.includes("home.newMailbox"),
		) as HTMLButtonElement;
		expect(open, "the new mailbox button").toBeTruthy();
		open.click();
		await settle();
		type("#mailbox-email", "new@example.com");
		type("#mailbox-name", "New");
		await nextTick();
		const form = (host.querySelector("#mailbox-email") as HTMLElement).closest(
			"form",
		) as HTMLFormElement;
		form.dispatchEvent(new Event("submit"));
		await settle();

		expect(createMailbox).toHaveBeenCalledOnce();
		expect(document.body.textContent).toContain("Mailbox created.");
		expect(document.body.textContent).not.toContain("Failed to create mailbox");
	});
});
