import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, h, nextTick } from "vue";
import { createI18n } from "vue-i18n";
import { createMemoryHistory, createRouter, RouterView } from "vue-router";

/**
 * /root, mounted for real: a login's password is set against that login and
 * with root's own password, and the reset sender says where it stands.
 */

const setAccountPassword = vi.fn(async () => ({ data: {} }));
const getRecoverySender = vi.fn();
const setRecoverySender = vi.fn();
const getResendSettings = vi.fn();
const setResendApiKey = vi.fn();

vi.mock("@/services/api", () => ({
	default: {
		listAccounts: vi.fn(async () => ({
			data: [
				{
					personId: "p-root",
					emails: ["op@example.com"],
					logins: [{ id: "u-root", email: "op@example.com" }],
					role: "root",
					createdAt: 1,
					deletionLocked: true,
				},
				{
					personId: "p-admin",
					emails: ["hanako@example.com", "spare@example.com"],
					logins: [
						{ id: "u-hanako", email: "hanako@example.com" },
						{ id: "u-spare", email: "spare@example.com" },
					],
					role: "admin",
					createdAt: 2,
					deletionLocked: true,
				},
			],
		})),
		getMaintenance: vi.fn(async () => ({ data: null })),
		setAccountPassword: (...a: unknown[]) => setAccountPassword(...(a as [])),
		getRecoverySender: (...a: unknown[]) => getRecoverySender(...(a as [])),
		setRecoverySender: (...a: unknown[]) => setRecoverySender(...(a as [])),
		adminGetResendSettings: (...a: unknown[]) =>
			getResendSettings(...(a as [])),
		adminSetResendApiKey: (...a: unknown[]) => setResendApiKey(...(a as [])),
		setAuthToken: vi.fn(),
		clearAuthToken: vi.fn(),
	},
}));

let host: HTMLElement;
let unmount = () => {};
beforeEach(() => {
	host = document.createElement("div");
	document.body.appendChild(host);
	setAccountPassword.mockClear();
	getRecoverySender.mockReset();
	setRecoverySender.mockReset();
	getResendSettings.mockReset();
	getResendSettings.mockResolvedValue({ data: { source: "none" } });
	setResendApiKey.mockReset();
});
afterEach(() => {
	unmount();
	host.remove();
});

const settle = async () => {
	for (let i = 0; i < 6; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await nextTick();
	}
};

async function mountRoot() {
	const pinia = createPinia();
	setActivePinia(pinia);
	const { default: Root } = await import("./Root.vue");
	const router = createRouter({
		history: createMemoryHistory(),
		routes: [
			{ path: "/root", component: Root },
			{ path: "/:rest(.*)*", component: { render: () => h("div") } },
		],
	});
	const app = createApp({ render: () => h(RouterView) });
	app
		.use(pinia)
		.use(router)
		.use(
			createI18n({
				legacy: false,
				locale: "en",
				messages: { en: {} },
				missingWarn: false,
				fallbackWarn: false,
			}),
		);
	await router.push("/root");
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

const formOf = (selector: string): HTMLFormElement => {
	const form = host.querySelector(selector)?.closest("form");
	if (!form) throw new Error(`no form around ${selector}`);
	return form;
};

describe("setting a login's password on /root", () => {
	/**
	 * The way back in for somebody who lost theirs, root's own spare
	 * included, with no mail involved. Against that login, and with root's
	 * own password -- setting somebody's is taking their account.
	 */
	it("sets it for that login, with root's own password", async () => {
		getRecoverySender.mockResolvedValue({
			data: { fromEmail: null, setByDeployment: false, enabled: false },
		});
		await mountRoot();

		const buttons = [...host.querySelectorAll("button")].filter(
			(b) => b.textContent?.trim() === "account.changePassword.title",
		);
		expect(buttons).toHaveLength(3);
		buttons[2].click();
		await settle();

		type("#pw-new-u-spare", "brand-new-password");
		type("#pw-own-u-spare", "roots-own-password");
		await nextTick();
		formOf("#pw-new-u-spare").dispatchEvent(new Event("submit"));
		await settle();

		expect(setAccountPassword).toHaveBeenCalledWith(
			"u-spare",
			"brand-new-password",
			"roots-own-password",
		);
		expect(host.textContent).toContain("account.changePassword.done");
	});
});

describe("the password-reset sender on /root", () => {
	it("says the flow is off while nothing is set, and saves an address", async () => {
		getRecoverySender.mockResolvedValue({
			data: { fromEmail: null, setByDeployment: false, enabled: false },
		});
		setRecoverySender.mockResolvedValue({
			data: {
				fromEmail: "noreply@example.com",
				setByDeployment: false,
				enabled: true,
			},
		});
		await mountRoot();
		expect(host.textContent).toContain("root.recovery.off");

		type("#recoveryFrom", "noreply@example.com");
		await nextTick();
		formOf("#recoveryFrom").dispatchEvent(new Event("submit"));
		await settle();

		expect(setRecoverySender).toHaveBeenCalledWith("noreply@example.com");
		expect(host.textContent).toContain("root.recovery.current");
		expect(host.textContent).not.toContain("root.recovery.off");
	});

	it("says when the deployment's own setting is the one in use", async () => {
		getRecoverySender.mockResolvedValue({
			data: { fromEmail: null, setByDeployment: true, enabled: true },
		});
		await mountRoot();
		expect(host.textContent).toContain("root.recovery.byDeployment");
	});
});

describe("root's own sending key on /root", () => {
	/**
	 * Root's reset mail and address-change confirmation go out with root's
	 * own key, and root cannot open /admin. Without this card that key had
	 * nowhere to be set, and root's reset mail leaned on the deployment-wide
	 * key left over from before keys were per person.
	 */
	it("says where root's key stands, and saves one", async () => {
		getRecoverySender.mockResolvedValue({
			data: { fromEmail: null, setByDeployment: false, enabled: false },
		});
		getResendSettings.mockResolvedValue({ data: { source: "environment" } });
		setResendApiKey.mockResolvedValue({ data: { source: "stored" } });
		await mountRoot();

		expect(getResendSettings).toHaveBeenCalled();
		expect(host.textContent).toContain("admin.resend.sourceEnvironment");

		type("#resendApiKey", "  re_roots_own  ");
		await nextTick();
		formOf("#resendApiKey").dispatchEvent(new Event("submit"));
		await settle();

		expect(setResendApiKey).toHaveBeenCalledWith("re_roots_own");
		expect(host.textContent).toContain("admin.resend.sourceStored");
		expect(host.textContent).toContain("admin.resend.saved");
	});
});
