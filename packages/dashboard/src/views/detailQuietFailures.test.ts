import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick } from "vue";
import { createMemoryHistory, createRouter, RouterView } from "vue-router";
import { englishWith } from "@/testing/english";

/**
 * What an open message does by itself, when the server refuses.
 *
 * Opening an unread message marks it read, and the screen also asked for the
 * folders; both were fired and forgotten, so a refusal was an unhandled
 * rejection. Marking read is not something the reader asked for, and the
 * message simply stays unread; the folders are the sidebar's to load.
 */

const updateEmail = vi.fn();
const listFolders = vi.fn();

vi.mock("@/services/api", () => ({
	default: {
		getEmail: vi.fn(async () => ({
			data: {
				id: "e1",
				subject: "s",
				sender: "a@example.org",
				recipient: "m@example.com",
				date: "2026-09-01T00:00:00.000Z",
				read: false,
				starred: false,
				folder_id: "inbox",
				body: "<p>x</p>",
				attachments: [],
			},
		})),
		updateEmail: (...a: unknown[]) => updateEmail(...a),
		listFolders: (...a: unknown[]) => listFolders(...a),
		setAuthToken: vi.fn(),
		clearAuthToken: vi.fn(),
	},
}));

vi.mock("@/components/EmailIframe.vue", () => ({
	default: defineComponent({ render: () => h("div") }),
}));

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);

let host: HTMLElement;
let unmount = () => {};
beforeEach(() => {
	host = document.createElement("div");
	document.body.appendChild(host);
	unhandled.length = 0;
	process.on("unhandledRejection", onUnhandled);
});
afterEach(() => {
	process.off("unhandledRejection", onUnhandled);
	unmount();
	host.remove();
});

const settle = async () => {
	for (let i = 0; i < 6; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await nextTick();
	}
};

describe("an open message", () => {
	it("leaves no unhandled rejection when marking it read is refused", async () => {
		updateEmail.mockRejectedValue(new Error("offline"));
		listFolders.mockRejectedValue(new Error("offline"));
		setActivePinia(createPinia());
		const { default: EmailDetail } = await import("./EmailDetail.vue");
		const blank = { render: () => h("div") };
		const router = createRouter({
			history: createMemoryHistory(),
			routes: [
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
		});
		const { i18n } = await import("@/i18n");
		i18n.global.setLocaleMessage("en", englishWith({}) as never);
		i18n.global.locale.value = "en" as never;
		await router.push("/mailbox/m%40example.com/email/e1?fromFolder=inbox");
		await router.isReady();
		const app = createApp({ render: () => h(RouterView) });
		app.use(router).use(i18n);
		app.mount(host);
		unmount = () => app.unmount();
		await settle();

		expect(updateEmail).toHaveBeenCalledOnce();
		// The sidebar asks for the folders, per mailbox; this screen does not.
		expect(listFolders).not.toHaveBeenCalled();
		expect(unhandled).toEqual([]);
	});
});
