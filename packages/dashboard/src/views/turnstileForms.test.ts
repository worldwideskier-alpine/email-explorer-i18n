import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Component, createApp, h, nextTick } from "vue";
import { createMemoryHistory, createRouter, RouterView } from "vue-router";
import type { TurnstileOptions } from "@/services/turnstile";
import { englishWith } from "@/testing/english";

/**
 * The forms a stranger can reach, with Turnstile on and off.
 *
 * On, each waits for the widget's token, sends it, and gets a fresh one after
 * a refusal -- a token passes once. Off, nothing is rendered and nothing is
 * fetched from Cloudflare at all.
 */

const getAppSettings = vi.fn();
const login = vi.fn();
const register = vi.fn();
const forgotPassword = vi.fn();
vi.mock("@/services/api", () => ({
	default: {
		getAppSettings: (...a: unknown[]) => getAppSettings(...a),
		login: (...a: unknown[]) => login(...a),
		register: (...a: unknown[]) => register(...a),
		forgotPassword: (...a: unknown[]) => forgotPassword(...a),
		setAuthToken: vi.fn(),
		clearAuthToken: vi.fn(),
	},
}));
vi.mock("@/services/push", () => ({ rebindPushSubscription: vi.fn() }));

let widgets: TurnstileOptions[] = [];
const turnstile = {
	render: vi.fn((_el: HTMLElement, options: TurnstileOptions) => {
		widgets.push(options);
		return String(widgets.length);
	}),
	reset: vi.fn(),
	remove: vi.fn(),
};

const SESSION = {
	id: "s1",
	userId: "u1",
	email: "op@example.com",
	role: "root",
	expiresAt: Date.now() + 60_000,
};

let host: HTMLElement;
let unmount = () => {};
beforeEach(() => {
	host = document.createElement("div");
	document.body.appendChild(host);
	widgets = [];
	turnstile.reset.mockClear();
	window.turnstile = turnstile;
	for (const f of [getAppSettings, login, register, forgotPassword]) {
		f.mockReset();
	}
	localStorage.clear();
});
afterEach(() => {
	unmount();
	host.remove();
	delete window.turnstile;
});

const settle = async () => {
	for (let i = 0; i < 6; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await nextTick();
	}
};

async function mount(path: string, siteKey: string | null) {
	getAppSettings.mockResolvedValue({
		data: {
			auth: { registerEnabled: true },
			accountRecovery: { enabled: true },
			turnstile: { siteKey },
		},
	});
	const { useAppSettings } = await import("@/composables/useAppSettings");
	await useAppSettings().fetchSettings();

	const pinia = createPinia();
	setActivePinia(pinia);
	const views: Record<string, () => Promise<{ default: Component }>> = {
		"/login": () => import("./Login.vue"),
		"/register": () => import("./Register.vue"),
		"/forgot-password": () => import("./ForgotPassword.vue"),
	};
	const view = (await views[path]()).default;
	const router = createRouter({
		history: createMemoryHistory(),
		routes: [
			{ path, component: view },
			{ path: "/:rest(.*)*", component: { render: () => h("div") } },
		],
	});
	await router.push(path);
	await router.isReady();
	const { i18n } = await import("@/i18n");
	i18n.global.setLocaleMessage("en", englishWith({}) as never);
	i18n.global.locale.value = "en" as never;
	const app = createApp({ render: () => h(RouterView) });
	app.use(pinia).use(router).use(i18n);
	app.mount(host);
	unmount = () => app.unmount();
	await settle();
}

function fill(id: string, value: string) {
	const field = host.querySelector(`#${id}`) as HTMLInputElement;
	field.value = value;
	field.dispatchEvent(new Event("input", { bubbles: true }));
}
const submit = () =>
	host.querySelector('button[type="submit"]') as HTMLButtonElement;
const send = async () => {
	(host.querySelector("form") as HTMLFormElement).dispatchEvent(
		new Event("submit", { cancelable: true }),
	);
	await settle();
};

describe("sign-in with Turnstile on", () => {
	it("waits for the token, sends it, and gets a new one after a refusal", async () => {
		await mount("/login", "0x4SITE");
		fill("email", "op@example.com");
		fill("password", "password123");
		await nextTick();

		expect(widgets.map((w) => w.sitekey)).toEqual(["0x4SITE"]);
		expect(submit().disabled).toBe(true);

		widgets[0].callback("token-1");
		await nextTick();
		expect(submit().disabled).toBe(false);

		login.mockRejectedValue({
			response: { status: 403, data: { error: "Bot check failed" } },
		});
		getAppSettings.mockClear();
		await send();
		expect(login).toHaveBeenCalledWith(
			"op@example.com",
			"password123",
			"token-1",
		);
		expect(turnstile.reset).toHaveBeenCalled();
		expect(submit().disabled).toBe(true);
		// A page from before Turnstile was turned on learns of it here.
		expect(getAppSettings).toHaveBeenCalled();
	});
});

describe("the widget's language", () => {
	it("is the page's, and follows it when it changes", async () => {
		// Left to "auto" it followed the browser, and a page in Japanese
		// said "Success!".
		await mount("/login", "0x4SITE");
		expect(widgets.map((w) => w.language)).toEqual(["en"]);

		const { i18n } = await import("@/i18n");
		i18n.global.setLocaleMessage("ja", englishWith({}) as never);
		i18n.global.locale.value = "ja" as never;
		await settle();
		expect(widgets.map((w) => w.language)).toEqual(["en", "ja"]);
		i18n.global.locale.value = "en" as never;
	});
});

describe("sign-in with Turnstile off", () => {
	it("renders no widget, loads nothing from Cloudflare, and sends no token", async () => {
		delete window.turnstile;
		const scriptsBefore = document.querySelectorAll("script").length;
		await mount("/login", null);
		fill("email", "op@example.com");
		fill("password", "password123");
		await nextTick();

		expect(widgets).toHaveLength(0);
		expect(document.querySelectorAll("script").length).toBe(scriptsBefore);
		expect(submit().disabled).toBe(false);

		login.mockResolvedValue({ data: SESSION });
		await send();
		expect(login).toHaveBeenCalledWith(
			"op@example.com",
			"password123",
			undefined,
		);
	});
});

describe("registration with Turnstile on", () => {
	it("is signed in by the registration itself, with no second token", async () => {
		await mount("/register", "0x4SITE");
		fill("email", "first@example.com");
		fill("password", "password123");
		fill("confirm-password", "password123");
		widgets[0].callback("token-1");
		await nextTick();

		register.mockResolvedValue({ data: { session: SESSION } });
		await send();
		expect(register).toHaveBeenCalledWith(
			"first@example.com",
			"password123",
			"token-1",
		);
		expect(login).not.toHaveBeenCalled();
		expect(JSON.parse(localStorage.getItem("session") ?? "{}").id).toBe("s1");
	});
});

describe("the reset request with Turnstile on", () => {
	it("sends the token with the request", async () => {
		await mount("/forgot-password", "0x4SITE");
		fill("email", "op@example.com");
		await nextTick();
		expect(submit().disabled).toBe(true);
		widgets[0].callback("token-1");
		await nextTick();

		forgotPassword.mockResolvedValue({ data: {} });
		await send();
		expect(forgotPassword).toHaveBeenCalledWith(
			"op@example.com",
			"en",
			"token-1",
		);
	});
});
