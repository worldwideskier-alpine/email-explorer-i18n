import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, h, nextTick } from "vue";
import { createMemoryHistory, createRouter, RouterView } from "vue-router";
import { englishWith } from "@/testing/english";

/**
 * The notifications switch on the settings screen, mounted for real.
 *
 * Turning notifications off lets go in the browser even when the Worker was
 * not told (unsubscribeFromPush), and the switch says what the browser
 * holds: it used to stay on when that call failed, over a browser that was
 * no longer subscribed.
 */

vi.mock("@/services/api", () => ({
	default: {
		getMailbox: async () => ({
			data: {
				id: "m@example.com",
				email: "m@example.com",
				name: "Now",
				settings: {
					fromName: "Now",
					signature: { enabled: false, html: "" },
					autoBackup: { enabled: false, frequency: "daily", keep: 3 },
				},
			},
		}),
		listBackups: async () => ({ data: [] }),
		setAuthToken: vi.fn(),
		clearAuthToken: vi.fn(),
	},
}));

const unsubscribeFromPush = vi.fn();

vi.mock("@/services/push", () => ({
	PushPermissionDenied: class extends Error {},
	isPushSupported: () => true,
	getExistingSubscription: async () => ({ endpoint: "https://push.test/x" }),
	subscribeToPush: async () => {},
	unsubscribeFromPush: () => unsubscribeFromPush(),
}));

let host: HTMLElement;
let unmount = () => {};

beforeEach(() => {
	host = document.createElement("div");
	document.body.appendChild(host);
	unsubscribeFromPush.mockReset();
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	unmount();
	host.remove();
	document.body.innerHTML = "";
	vi.restoreAllMocks();
});

const settle = async () => {
	for (let i = 0; i < 6; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await nextTick();
	}
};

async function mountSettings() {
	const pinia = createPinia();
	setActivePinia(pinia);
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

const pushSwitch = () =>
	host.querySelector(
		'[role="switch"][aria-label="Push Notifications"]',
	) as HTMLButtonElement | null;

describe("turning notifications off", () => {
	it("reads off when the Worker was not told, and says it failed", async () => {
		unsubscribeFromPush.mockRejectedValue(new Error("503"));
		await mountSettings();
		expect(pushSwitch()?.getAttribute("aria-checked")).toBe("true");

		pushSwitch()?.click();
		await settle();

		expect(unsubscribeFromPush).toHaveBeenCalledTimes(1);
		expect(pushSwitch()?.getAttribute("aria-checked")).toBe("false");
		expect(host.textContent).toContain(
			"Failed to update push notification settings",
		);
	});

	it("reads off when it went through", async () => {
		unsubscribeFromPush.mockResolvedValue(undefined);
		await mountSettings();
		pushSwitch()?.click();
		await settle();
		expect(pushSwitch()?.getAttribute("aria-checked")).toBe("false");
	});
});
