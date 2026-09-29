import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick } from "vue";
import {
	createMemoryHistory,
	createRouter,
	RouterView,
	useRoute,
} from "vue-router";
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

/**
 * The screens inside the frame read their message, folder or mailbox when
 * they are first shown -- EmailDetail, EmailSource, Settings and Contacts on
 * mount, EmailList by folder name alone. The frame's router-view reused them
 * when only the path's ids changed, so a notification for another message
 * left the open one on screen, and the next reply, move or delete went to
 * the message shown rather than the one in the address bar. Inbox in one
 * mailbox and inbox in the next were the same list.
 */
describe("the screen inside the mailbox frame", () => {
	/** Reads the path once, as those screens do. */
	const ReadsOnce = defineComponent({
		setup() {
			const route = useRoute();
			const seen = `${route.params.mailboxId}|${route.params.id ?? route.params.folder}`;
			return () => h("p", { class: "seen" }, seen);
		},
	});

	it("is shown afresh for another message, folder or mailbox", async () => {
		const pinia = createPinia();
		setActivePinia(pinia);
		const { default: Mailbox } = await import("./Mailbox.vue");
		const router = createRouter({
			history: createMemoryHistory(),
			routes: [
				{
					path: "/mailbox/:mailboxId",
					name: "Mailbox",
					component: Mailbox,
					children: [
						{ path: "emails/:folder", name: "EmailList", component: ReadsOnce },
						{ path: "email/:id", name: "EmailDetail", component: ReadsOnce },
						{ path: "settings", name: "Settings", component: ReadsOnce },
						{ path: "contacts", name: "Contacts", component: ReadsOnce },
					],
				},
				{ path: "/:rest(.*)*", name: "Home", component: ReadsOnce },
			],
		});
		const { i18n } = await import("@/i18n");
		i18n.global.setLocaleMessage("en", englishWith({}) as never);
		i18n.global.locale.value = "en" as never;
		await router.push("/mailbox/a%40example.com/email/m1");
		await router.isReady();
		const app = createApp({ render: () => h(RouterView) });
		app.use(pinia).use(router).use(i18n);
		app.mount(host);
		unmount = () => app.unmount();
		await settle();
		const seen = () => host.querySelector(".seen")?.textContent;
		expect(seen()).toBe("a@example.com|m1");

		await router.push("/mailbox/a%40example.com/email/m2");
		await settle();
		expect(seen()).toBe("a@example.com|m2");

		await router.push("/mailbox/b%40example.com/email/m2");
		await settle();
		expect(seen()).toBe("b@example.com|m2");

		await router.push("/mailbox/b%40example.com/emails/inbox");
		await settle();
		await router.push("/mailbox/a%40example.com/emails/inbox");
		await settle();
		expect(seen()).toBe("a@example.com|inbox");
	});
});
