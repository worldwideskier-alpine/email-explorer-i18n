import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick } from "vue";
import { createMemoryHistory, createRouter, RouterView } from "vue-router";
import { englishWith } from "@/testing/english";

/**
 * Moving from one mailbox to another inside the page.
 *
 * A tapped notification for mailbox B, with mailbox A open, is routed inside
 * the page (main.ts). The mailbox's frame and its sidebar were reused and
 * loaded their mailbox only when first shown, so B's message sat inside A:
 * a reply went out from A to B's path and was refused, reply-all left B's
 * own address in To with A's signature, and the sidebar listed A's folders.
 */

const getMailbox = vi.fn(async (id: string) => ({
	data: { id, email: id, name: id, settings: {} },
}));
const listFolders = vi.fn(async (id: string) => ({
	data: [{ id: `f-${id}`, name: `Folder of ${id}` }],
}));

vi.mock("@/services/api", () => ({
	default: {
		getMailbox: (id: string) => getMailbox(id),
		listFolders: (id: string) => listFolders(id),
		setAuthToken: vi.fn(),
		clearAuthToken: vi.fn(),
	},
}));

// The frame's other parts are not what this is about.
vi.mock("@/components/Header.vue", () => ({
	default: defineComponent({ render: () => h("div") }),
}));
vi.mock("@/components/ComposeEmail.vue", () => ({
	default: defineComponent({ render: () => h("div") }),
}));

let host: HTMLElement;
let unmount = () => {};
beforeEach(() => {
	host = document.createElement("div");
	document.body.appendChild(host);
	getMailbox.mockClear();
	listFolders.mockClear();
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

describe("moving to another mailbox inside the page", () => {
	it("loads the new mailbox and its folders", async () => {
		const pinia = createPinia();
		setActivePinia(pinia);
		const { default: Mailbox } = await import("./Mailbox.vue");
		const blank = { render: () => h("div") };
		const router = createRouter({
			history: createMemoryHistory(),
			routes: [
				{
					path: "/mailbox/:mailboxId",
					name: "Mailbox",
					component: Mailbox,
					children: [
						{ path: "emails/:folder", name: "EmailList", component: blank },
						{ path: "email/:id", name: "EmailDetail", component: blank },
						{ path: "settings", name: "Settings", component: blank },
						{ path: "contacts", name: "Contacts", component: blank },
					],
				},
				{ path: "/:rest(.*)*", name: "Home", component: blank },
			],
		});
		const { i18n } = await import("@/i18n");
		i18n.global.setLocaleMessage("en", englishWith({}) as never);
		i18n.global.locale.value = "en" as never;
		await router.push("/mailbox/a%40example.com/emails/inbox");
		await router.isReady();
		const app = createApp({ render: () => h(RouterView) });
		app.use(pinia).use(router).use(i18n);
		app.mount(host);
		unmount = () => app.unmount();
		await settle();

		const { useMailboxStore } = await import("@/stores/mailboxes");
		expect(useMailboxStore().currentMailbox?.id).toBe("a@example.com");
		expect(host.textContent).toContain("Folder of a@example.com");

		await router.push("/mailbox/b%40example.com/email/m1");
		await settle();

		expect(getMailbox).toHaveBeenLastCalledWith("b@example.com");
		expect(useMailboxStore().currentMailbox?.id).toBe("b@example.com");
		expect(listFolders).toHaveBeenLastCalledWith("b@example.com");
		expect(host.textContent).toContain("Folder of b@example.com");
		expect(host.textContent).not.toContain("Folder of a@example.com");
	});
});
