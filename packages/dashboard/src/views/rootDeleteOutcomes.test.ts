import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, h, nextTick } from "vue";
import { createI18n } from "vue-i18n";
import { createMemoryHistory, createRouter, RouterView } from "vue-router";

/**
 * What /root says after "delete this person", mounted for real.
 *
 * Every failure used to be "Could not delete", with the list left as it was.
 * Two of them are not failures to delete: a 500 carrying `unfinished` means
 * the person is gone and some mail is still being removed (asking again
 * answered 404), and a 404 means they are gone already. A 423 means the
 * lock went back on meanwhile, which the screen can say.
 */

const deletePerson = vi.fn();
const listAccounts = vi.fn();

vi.mock("@/services/api", () => ({
	default: {
		listAccounts: (...a: unknown[]) => listAccounts(...(a as [])),
		deletePerson: (...a: unknown[]) => deletePerson(...(a as [])),
		getMaintenance: vi.fn(async () => ({ data: null })),
		getMaintenanceHistory: vi.fn(async () => ({ data: [] })),
		getRecoverySender: vi.fn(async () => ({
			data: { fromEmail: null, setByDeployment: false, enabled: false },
		})),
		adminGetResendSettings: vi.fn(async () => ({ data: { source: "none" } })),
		getTurnstile: vi.fn(async () => ({
			data: { siteKey: null, secretKey: null },
		})),
		setAuthToken: vi.fn(),
		clearAuthToken: vi.fn(),
	},
}));

const people = [
	{
		personId: "p-root",
		emails: ["op@example.com"],
		logins: [{ id: "u-root", email: "op@example.com" }],
		role: "root",
		createdAt: 1,
		deletionLocked: true,
	},
	{
		personId: "p-leaver",
		emails: ["leaver@example.com"],
		logins: [{ id: "u-leaver", email: "leaver@example.com" }],
		role: "admin",
		createdAt: 2,
		deletionLocked: false,
	},
];

let host: HTMLElement;
let unmount = () => {};
beforeEach(() => {
	host = document.createElement("div");
	document.body.appendChild(host);
	deletePerson.mockReset();
	listAccounts.mockReset();
	listAccounts.mockResolvedValue({ data: people });
	vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => {
	unmount();
	host.remove();
	vi.restoreAllMocks();
});

const settle = async () => {
	for (let i = 0; i < 6; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await nextTick();
	}
};

async function deleteTheLeaver(after: unknown[] = [people[0]]) {
	setActivePinia(createPinia());
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
		.use(createPinia())
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

	const button = [...host.querySelectorAll("button")].find(
		(b) => b.textContent?.trim() === "root.deleteAccount",
	);
	expect(button, "the delete button").toBeDefined();
	listAccounts.mockClear();
	listAccounts.mockResolvedValue({ data: after });
	button?.click();
	await settle();
}

const refusal = (status: number, data: unknown) =>
	Object.assign(new Error(`status ${status}`), { response: { status, data } });

describe("deleting a person on /root", () => {
	it("says deleted, and shows the list without them", async () => {
		deletePerson.mockResolvedValue({ data: { status: "deleted" } });
		await deleteTheLeaver();
		expect(host.textContent).toContain("root.deleted");
		expect(listAccounts).toHaveBeenCalled();
		expect(host.textContent).not.toContain("leaver@example.com");
	});

	it("says deleted with mail still going, not could-not-delete", async () => {
		deletePerson.mockRejectedValue(
			refusal(500, {
				error: "Some mailboxes could not be emptied",
				unfinished: ["box@example.com"],
			}),
		);
		await deleteTheLeaver();
		expect(host.textContent).toContain("root.deletedUnfinished");
		expect(host.textContent).not.toContain("root.deleteFailed");
		expect(listAccounts).toHaveBeenCalled();
		expect(host.textContent).not.toContain("leaver@example.com");
	});

	it("says deleted when they were gone already", async () => {
		deletePerson.mockRejectedValue(refusal(404, { error: "Not found" }));
		await deleteTheLeaver();
		expect(host.textContent).toContain("root.deleted");
		expect(host.textContent).not.toContain("root.deleteFailed");
		expect(listAccounts).toHaveBeenCalled();
	});

	it("says locked when the lock went back on", async () => {
		deletePerson.mockRejectedValue(
			refusal(423, { error: "Person is protected from deletion" }),
		);
		await deleteTheLeaver([people[0], { ...people[1], deletionLocked: true }]);
		expect(host.textContent).toContain("root.lock.lockedHint");
		expect(host.textContent).not.toContain("root.deleteFailed");
	});

	it("says could not delete when it could not", async () => {
		deletePerson.mockRejectedValue(new Error("Network Error"));
		await deleteTheLeaver();
		expect(host.textContent).toContain("root.deleteFailed");
		expect(listAccounts).toHaveBeenCalled();
	});
});
