import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, h } from "vue";
import { createMemoryHistory, createRouter, RouterView } from "vue-router";
import { englishWith } from "@/testing/english";

/**
 * A folder of one's own is listed whatever it is called.
 *
 * The list of custom folders left out the system ones by *name*, so a folder
 * renamed "Spam" -- or restored from a backup as "trash", which gets an id of
 * its own because "trash" is taken -- disappeared from the sidebar, mail and
 * all, with nothing leading back to it. The system folders are known by id.
 */

vi.mock("@/services/api", () => ({
	default: {
		listFolders: vi.fn(async () => ({
			data: [
				{ id: "inbox", name: "Inbox" },
				{ id: "spam", name: "Spam" },
				{ id: "trash", name: "Trash" },
				{ id: "receipts", name: "Spam" },
				{ id: "3f1c2a4e-0000-4000-8000-000000000000", name: "trash" },
				{ id: "projects", name: "Projects" },
			],
		})),
		setAuthToken: vi.fn(),
		clearAuthToken: vi.fn(),
	},
}));

let unmount = () => {};
afterEach(() => {
	unmount();
	document.body.innerHTML = "";
});

describe("the custom folders", () => {
	it("are every folder but the system ones, by id", async () => {
		setActivePinia(createPinia());
		const { default: Sidebar } = await import("./Sidebar.vue");
		const router = createRouter({
			history: createMemoryHistory(),
			routes: [
				{
					path: "/mailbox/:mailboxId/emails/:folder",
					name: "EmailList",
					component: { render: () => h("div") },
				},
			],
		});
		const { i18n } = await import("@/i18n");
		i18n.global.setLocaleMessage("en", englishWith() as never);
		i18n.global.locale.value = "en" as never;
		await router.push("/mailbox/m%40example.com/emails/inbox");
		await router.isReady();
		const host = document.createElement("div");
		document.body.appendChild(host);
		const app = createApp({ render: () => [h(RouterView), h(Sidebar)] });
		app.use(router).use(i18n);
		app.mount(host);
		unmount = () => app.unmount();
		for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));

		const custom = [...host.querySelectorAll("a")]
			.map((a) => a.getAttribute("href") ?? "")
			.filter((href) => href.startsWith("/mailbox/m@example.com/emails/"))
			.map((href) => href.split("/").pop());
		// Each system folder once -- its fixed entry -- and every folder of
		// the person's own, whatever its name.
		expect(custom.filter((id) => id === "spam")).toHaveLength(1);
		expect(custom.filter((id) => id === "trash")).toHaveLength(1);
		expect(custom).toContain("receipts");
		expect(custom).toContain("3f1c2a4e-0000-4000-8000-000000000000");
		expect(custom).toContain("projects");
	});
});
