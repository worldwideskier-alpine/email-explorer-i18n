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
const getMaintenance = vi.fn();
const getMaintenanceHistory = vi.fn();
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
		getMaintenance: (...a: unknown[]) => getMaintenance(...(a as [])),
		getMaintenanceHistory: (...a: unknown[]) =>
			getMaintenanceHistory(...(a as [])),
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
	getMaintenance.mockReset();
	getMaintenance.mockResolvedValue({ data: null });
	getMaintenanceHistory.mockReset();
	getMaintenanceHistory.mockResolvedValue({ data: [] });
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
	input.dispatchEvent(new Event("input", { bubbles: true }));
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

	/**
	 * A sender that is set arrives in the box, and a filled box counted as
	 * writing the whole time the screen was open: a session that ended here
	 * did not go to sign-in, and a new build was never picked up.
	 */
	it("is writing only once the sender has been typed into", async () => {
		const { somethingIsBeingWritten } = await import("@/services/appUpdate");
		getRecoverySender.mockResolvedValue({
			data: {
				fromEmail: "noreply@example.com",
				setByDeployment: false,
				enabled: true,
			},
		});
		setRecoverySender.mockResolvedValue({
			data: {
				fromEmail: "reset@example.com",
				setByDeployment: false,
				enabled: true,
			},
		});
		await mountRoot();
		expect(
			(host.querySelector("#recoveryFrom") as HTMLInputElement).value,
		).toBe("noreply@example.com");
		expect(somethingIsBeingWritten(document)).toBe(false);

		type("#recoveryFrom", "reset@example.com");
		await nextTick();
		expect(somethingIsBeingWritten(document)).toBe(true);

		formOf("#recoveryFrom").dispatchEvent(new Event("submit"));
		await settle();
		expect(setRecoverySender).toHaveBeenCalledWith("reset@example.com");
		expect(somethingIsBeingWritten(document)).toBe(false);
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
		getResendSettings.mockResolvedValue({ data: { source: "none" } });
		setResendApiKey.mockResolvedValue({ data: { source: "stored" } });
		await mountRoot();

		expect(getResendSettings).toHaveBeenCalled();
		expect(host.textContent).toContain("admin.resend.sourceNone");

		type("#resendApiKey", "  re_roots_own  ");
		await nextTick();
		formOf("#resendApiKey").dispatchEvent(new Event("submit"));
		await settle();

		expect(setResendApiKey).toHaveBeenCalledWith("re_roots_own");
		expect(host.textContent).toContain("admin.resend.sourceStored");
		expect(host.textContent).not.toContain("admin.resend.sourceNone");
		expect(host.textContent).toContain("admin.resend.saved");
	});
});

describe("earlier nights on /root", () => {
	/**
	 * 2026-09-22: cut off after fifteen minutes inside the backups, and
	 * replaced by the next night's record before anybody looked. It is listed
	 * in the sentence last night would have had; a night that went well is
	 * not listed at all, so the one that matters is not buried.
	 */
	it("lists a night that did not finish, and not one that did", async () => {
		getRecoverySender.mockResolvedValue({
			data: { fromEmail: null, setByDeployment: false, enabled: false },
		});
		getMaintenance.mockResolvedValue({
			data: {
				startedAt: "2026-09-26T18:00:25.613Z",
				finishedAt: "2026-09-26T18:08:38.000Z",
				backups: { finishedAt: "2026-09-26T18:07:00.000Z", ran: 2, failed: 0 },
				spamPurge: {
					finishedAt: "2026-09-26T18:08:30.000Z",
					ran: 2,
					deleted: 1,
					failed: 0,
				},
			},
		});
		getMaintenanceHistory.mockResolvedValue({
			data: [
				{
					startedAt: "2026-09-23T18:00:38.032Z",
					finishedAt: "2026-09-23T18:08:00.000Z",
					backups: {
						finishedAt: "2026-09-23T18:07:00.000Z",
						ran: 2,
						failed: 0,
					},
					spamPurge: {
						finishedAt: "2026-09-23T18:07:50.000Z",
						ran: 2,
						deleted: 0,
						failed: 0,
					},
				},
				{
					startedAt: "2026-09-22T18:00:53.757Z",
					backupProgress: {
						mailbox: "b@example.com",
						index: 2,
						of: 2,
						messages: 0,
					},
				},
			],
		});
		await mountRoot();

		const lines = [...host.querySelectorAll("li.text-amber-700")].map(
			(li) => li.textContent ?? "",
		);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("root.maintenance.killedInBackup");
		// Last night's own line is unchanged by any of this.
		expect(host.textContent).toContain("root.maintenance.done");
	});

	it("lists nothing when every earlier night went well", async () => {
		getRecoverySender.mockResolvedValue({
			data: { fromEmail: null, setByDeployment: false, enabled: false },
		});
		getMaintenanceHistory.mockResolvedValue({
			data: [
				{
					startedAt: "2026-09-23T18:00:38.032Z",
					finishedAt: "2026-09-23T18:08:00.000Z",
					backups: {
						finishedAt: "2026-09-23T18:07:00.000Z",
						ran: 2,
						failed: 0,
					},
					spamPurge: {
						finishedAt: "2026-09-23T18:07:50.000Z",
						ran: 2,
						deleted: 0,
						failed: 0,
					},
				},
			],
		});
		await mountRoot();
		expect(host.querySelectorAll("li.text-amber-700")).toHaveLength(0);
	});
});
