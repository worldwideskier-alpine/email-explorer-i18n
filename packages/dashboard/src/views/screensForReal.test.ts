import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick } from "vue";
import { createI18n } from "vue-i18n";
import { createMemoryHistory, createRouter, RouterView } from "vue-router";

/**
 * Screens mounted for real, for what only shows on a screen: where a click
 * goes, what the frame is handed, what the source box keeps.
 */

const frameProps: Record<string, unknown>[] = [];
vi.mock("@/components/EmailIframe.vue", () => ({
	default: defineComponent({
		props: ["body", "disableLinks", "blockRemoteContent"],
		setup(props) {
			return () => {
				frameProps.push({ ...props });
				return h("div");
			};
		},
	}),
}));

let stored: Record<string, unknown> = {};
let rows: Record<string, unknown>[] = [];
const getEmail = vi.fn(async () => ({ data: stored }));
const login = vi.fn(async () => ({
	data: {
		id: "s",
		userId: "u",
		email: "a@example.com",
		role: "admin",
		expiresAt: Date.now() + 60_000,
	},
}));

vi.mock("@/services/api", () => ({
	default: {
		getEmail: (...args: unknown[]) => getEmail(...(args as [])),
		listEmails: vi.fn(async () => ({ data: rows })),
		listFolders: vi.fn(async () => ({ data: [] })),
		updateEmail: vi.fn(async () => ({ data: {} })),
		getCurrentUser: vi.fn(async () => ({
			data: { id: "u", email: "root@example.com", role: "root" },
		})),
		login: (...args: unknown[]) => login(...(args as [])),
		setAuthToken: vi.fn(),
		clearAuthToken: vi.fn(),
		logout: vi.fn(async () => ({})),
		getAppSettings: vi.fn(async () => ({ data: {} })),
		subscribePush: vi.fn(async () => ({})),
	},
}));

const i18n = () =>
	createI18n({
		legacy: false,
		locale: "en",
		messages: { en: {} },
		missingWarn: false,
		fallbackWarn: false,
	});

let host: HTMLElement;
let unmount: () => void = () => {};

// jsdom has none; the list uses it only to load more on scroll.
vi.stubGlobal(
	"IntersectionObserver",
	class {
		observe() {}
		unobserve() {}
		disconnect() {}
	},
);

beforeEach(() => {
	host = document.createElement("div");
	document.body.appendChild(host);
	frameProps.length = 0;
	localStorage.clear();
	getEmail.mockClear();
});

afterEach(() => {
	unmount();
	host.remove();
});

const settle = async () => {
	for (let i = 0; i < 5; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await nextTick();
	}
};

describe("root", () => {
	/**
	 * Every screen but its own used to send root to /root -- its password
	 * and sign-in address among them, so it could not change its password.
	 * /admin still goes there: root adds its spare addresses from /root.
	 */
	it("can open its own account screen, and no one's mailbox", async () => {
		setActivePinia(createPinia());
		localStorage.setItem(
			"session",
			JSON.stringify({
				id: "s",
				userId: "u",
				email: "root@example.com",
				role: "root",
				expiresAt: Date.now() + 60_000,
			}),
		);
		const { default: router } = await import("@/router");
		for (const [path, name] of [
			["/account", "Account"],
			["/admin", "Root"],
			["/mailbox/x/emails/inbox", "Root"],
		]) {
			await router.push(path);
			expect(router.currentRoute.value.name, path).toBe(name);
		}
	});
});

describe("signing in", () => {
	async function signInWith(redirect: string) {
		setActivePinia(createPinia());
		const { default: Login } = await import("./Login.vue");
		const blank = defineComponent({ render: () => h("div") });
		const router = createRouter({
			history: createMemoryHistory(),
			routes: [
				{ path: "/login", name: "Login", component: Login },
				{ path: "/:rest(.*)*", name: "Other", component: blank },
			],
		});
		const app = createApp({ render: () => h(RouterView) });
		app.use(createPinia()).use(router).use(i18n());
		await router.push({ path: "/login", query: { redirect } });
		await router.isReady();
		app.mount(host);
		unmount = () => app.unmount();
		await settle();
		(host.querySelector("input[type=email]") as HTMLInputElement).value =
			"a@example.com";
		host.querySelector("input[type=email]")?.dispatchEvent(new Event("input"));
		(host.querySelector("input[type=password]") as HTMLInputElement).value =
			"password123";
		host
			.querySelector("input[type=password]")
			?.dispatchEvent(new Event("input"));
		host.querySelector("form")?.dispatchEvent(new Event("submit"));
		await settle();
		return router.currentRoute.value.fullPath;
	}

	it("goes where the person was headed", async () => {
		expect(await signInWith("/mailbox/a%40b.c/email/1")).toBe(
			"/mailbox/a%40b.c/email/1",
		);
	});

	it("goes nowhere off this site", async () => {
		expect(await signInWith("//evil.example/path")).toBe("/");
		expect(await signInWith("https://evil.example/")).toBe("/");
	});
});

async function mountMailbox(path: string) {
	setActivePinia(createPinia());
	const { default: EmailList } = await import("./EmailList.vue");
	const { default: EmailDetail } = await import("./EmailDetail.vue");
	const blank = defineComponent({ render: () => h("div") });
	const router = createRouter({
		history: createMemoryHistory(),
		routes: [
			{
				path: "/mailbox/:mailboxId/emails/:folder",
				name: "EmailList",
				component: EmailList,
			},
			{
				path: "/mailbox/:mailboxId/email/:id",
				name: "EmailDetail",
				component: EmailDetail,
			},
			{
				path: "/mailbox/:mailboxId/email/:id/source",
				name: "EmailSource",
				component: blank,
			},
		],
	});
	const pinia = createPinia();
	setActivePinia(pinia);
	const app = createApp({ render: () => h(RouterView) });
	app.use(pinia).use(router).use(i18n());
	await router.push(path);
	await router.isReady();
	app.mount(host);
	unmount = () => app.unmount();
	await settle();
	return router;
}

describe("a draft in the list", () => {
	/**
	 * It opens in the composer, and only there. The link used to navigate
	 * before the click handler ran, so the message screen opened behind the
	 * composer and marked the draft read.
	 */
	it("opens the composer without leaving the list", async () => {
		rows = [
			{
				id: "d1",
				subject: "draft",
				sender: "me@example.com",
				recipient: "",
				date: "2026-09-01T00:00:00.000Z",
				read: true,
				starred: false,
				folder_id: "draft",
			},
		];
		stored = { ...rows[0], body: "<p>x</p>", attachments: [] };
		const router = await mountMailbox("/mailbox/me%40example.com/emails/draft");
		const { useUIStore } = await import("@/stores/ui");

		host
			.querySelector("li a")
			?.dispatchEvent(
				new MouseEvent("click", { bubbles: true, cancelable: true }),
			);
		await settle();

		expect(router.currentRoute.value.name).toBe("EmailList");
		expect(useUIStore().composeOptions.mode).toBe("draft");
	});
});

describe("inline pictures", () => {
	/**
	 * `cid:img1` is also the start of `cid:img10`. Taken first, it rewrote
	 * img10's reference into img1's address with a "0" after it.
	 */
	it("each get their own address when one id begins another", async () => {
		stored = {
			id: "e1",
			subject: "pictures",
			sender: "a@example.org",
			recipient: "me@example.com",
			date: "2026-09-01T00:00:00.000Z",
			read: true,
			starred: false,
			folder_id: "inbox",
			body: '<img src="cid:img1"><img src="cid:img10">',
			attachments: [
				{
					id: "att-one",
					filename: "1.png",
					mimetype: "image/png",
					size: 1,
					content_id: "<img1>",
					disposition: "inline",
				},
				{
					id: "att-ten",
					filename: "10.png",
					mimetype: "image/png",
					size: 1,
					content_id: "<img10>",
					disposition: "inline",
				},
			],
		};
		await mountMailbox("/mailbox/me%40example.com/email/e1?fromFolder=inbox");
		const body = String(frameProps[frameProps.length - 1]?.body ?? "");
		const sources = [...body.matchAll(/src="([^"]*)"/g)].map((m) => m[1]);
		expect(sources).toHaveLength(2);
		expect(sources[0]).toMatch(/att-one$/);
		expect(sources[1]).toMatch(/att-ten$/);
	});
});
