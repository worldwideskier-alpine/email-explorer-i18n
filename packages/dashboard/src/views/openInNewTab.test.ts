import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick } from "vue";
import { createMemoryHistory, createRouter, RouterView } from "vue-router";
import { englishWith } from "@/testing/english";

/**
 * "Open in a new tab" beside an attachment's download: offered for what the
 * Worker serves to be shown -- a PDF or a picture -- and for nothing else, and
 * not in the installed app, whose new tab carries no session cookie.
 */

vi.mock("@/services/api", () => ({
	default: {
		getEmail: vi.fn(async () => ({
			data: {
				id: "e1",
				subject: "s",
				sender: "a@example.org",
				recipient: "m@example.com",
				date: "2026-09-01T00:00:00.000Z",
				read: true,
				starred: false,
				folder_id: "inbox",
				body: "<p>x</p>",
				attachments: [
					{
						id: "a1",
						filename: "plan.pdf",
						mimetype: "application/pdf",
						size: 10,
						opensInline: true,
					},
					{
						id: "a2",
						filename: "files.zip",
						mimetype: "application/zip",
						size: 10,
						opensInline: false,
					},
					// From a Worker that did not say: not offered.
					{
						id: "a3",
						filename: "photo.jpg",
						mimetype: "image/jpeg",
						size: 10,
					},
				],
			},
		})),
		updateEmail: vi.fn(async () => ({})),
		listFolders: vi.fn(async () => ({ data: [] })),
		setAuthToken: vi.fn(),
		clearAuthToken: vi.fn(),
	},
}));

vi.mock("@/components/EmailIframe.vue", () => ({
	default: defineComponent({ render: () => h("div") }),
}));

let host: HTMLElement;
let unmount = () => {};
beforeEach(() => {
	host = document.createElement("div");
	document.body.appendChild(host);
});
afterEach(() => {
	unmount();
	host.remove();
	vi.unstubAllGlobals();
});

const settle = async () => {
	for (let i = 0; i < 6; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await nextTick();
	}
};

async function openMessage() {
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
}

const openLinks = () => [
	...host.querySelectorAll<HTMLAnchorElement>('[data-test="open-in-new-tab"]'),
];

describe("an attachment's open-in-a-new-tab", () => {
	it("is offered for a PDF the Worker shows, and not for an archive", async () => {
		await openMessage();
		const links = openLinks();
		expect(links).toHaveLength(1);
		const [link] = links;
		expect(link.getAttribute("href")).toBe(
			"/api/v1/mailboxes/m@example.com/emails/e1/attachments/a1",
		);
		expect(link.getAttribute("target")).toBe("_blank");
		expect(link.getAttribute("rel")).toContain("noopener");
		expect(link.getAttribute("title")).toBe("Open in a new tab");
		// Every attachment keeps its download.
		expect(host.textContent).toContain("files.zip");
		expect(host.querySelectorAll('button[title="Download"]').length).toBe(3);
	});

	it("is not offered in the installed app", async () => {
		vi.stubGlobal(
			"matchMedia",
			(query: string) =>
				({ matches: query === "(display-mode: standalone)" }) as MediaQueryList,
		);
		await openMessage();
		expect(openLinks()).toHaveLength(0);
		expect(host.querySelectorAll('button[title="Download"]').length).toBe(3);
	});
});
