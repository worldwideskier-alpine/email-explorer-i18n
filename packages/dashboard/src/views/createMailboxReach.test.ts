import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, h, nextTick } from "vue";
import { createMemoryHistory, createRouter, RouterView } from "vue-router";
import { englishWith } from "@/testing/english";

/**
 * The create-mailbox dialog on Home can be closed and submitted however
 * short the window.
 *
 * It sat centred in a fixed overlay with no height of its own, so on a phone
 * held sideways it ran past the top and the bottom of the window, where the
 * overlay -- fixed, and not a scroller -- gave no way to reach it. Measured in
 * Chromium, Japanese and German, with the 409 "already exists" banner up:
 *
 *   568x320   65px past the top and the bottom; close and Create unpressable
 *   740x360   45px past each; close unpressable
 *   667x375   37px past each
 *   and without the banner, 29px (568x320), 9px (740x360), 1px (667x375)
 *
 * It is held to the window now (max-h-full of the padded overlay), and the
 * form scrolls under the title and its close button, which stay in sight.
 *
 * jsdom lays nothing out, so this holds the rules: the dialog is held to its
 * overlay's height, the form is what scrolls, the close button is outside
 * it, and nothing between the form and its buttons hides what overflows it.
 * Re-measure in a browser after changing it.
 */

const createMailbox = vi.fn();

vi.mock("@/services/api", () => ({
	default: {
		listMailboxes: vi.fn(async () => ({ data: [] })),
		createMailbox: (...a: unknown[]) => createMailbox(...a),
		setAuthToken: vi.fn(),
		clearAuthToken: vi.fn(),
	},
}));

let host: HTMLElement;
let unmount = () => {};
beforeEach(() => {
	host = document.createElement("div");
	document.body.appendChild(host);
	createMailbox.mockReset();
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

async function openDialog() {
	const pinia = createPinia();
	setActivePinia(pinia);
	const { default: Home } = await import("./Home.vue");
	const router = createRouter({
		history: createMemoryHistory(),
		routes: [
			{ path: "/", component: Home },
			{ path: "/:rest(.*)*", component: { render: () => h("div") } },
		],
	});
	const { i18n } = await import("@/i18n");
	i18n.global.setLocaleMessage("en", englishWith({}) as never);
	i18n.global.locale.value = "en" as never;
	const app = createApp({ render: () => h(RouterView) });
	await router.push("/");
	await router.isReady();
	app.use(pinia).use(router).use(i18n);
	app.mount(host);
	unmount = () => app.unmount();
	await settle();
	const open = [...host.querySelectorAll("button")].find(
		(button) => button.textContent?.trim() === "New Mailbox",
	);
	expect(open, "the button that opens the dialog").toBeDefined();
	open?.click();
	await settle();
	const field = host.querySelector("#mailbox-email") as HTMLInputElement;
	expect(field, "the dialog").not.toBeNull();
	const form = field.closest("form") as HTMLFormElement;
	const overlay = host.querySelector("div.fixed.inset-0") as HTMLElement;
	const box = form.parentElement as HTMLElement;
	return { field, form, overlay, box };
}

/** Class names without their variants, `!` and the like. */
const bare = (element: Element) =>
	[...element.classList].map((name) =>
		name.replace(/^.*:/, "").replace(/^!|!$/g, ""),
	);

const hidesOverflow = (element: Element) =>
	bare(element).some((name) =>
		/^overflow(-y)?-(hidden|clip)$|^\[overflow(-y)?:(hidden|clip)\]$/.test(
			name,
		),
	) ||
	/overflow(-y)?\s*:\s*(hidden|clip)/.test(element.getAttribute("style") ?? "");

describe("the create-mailbox dialog", () => {
	it("is held to the window", async () => {
		const { overlay, box } = await openDialog();
		expect(box.parentElement).toBe(overlay);
		// The overlay is the window, less its padding; the dialog may be no
		// taller than that.
		expect(bare(overlay)).toEqual(
			expect.arrayContaining(["fixed", "inset-0", "flex", "items-center"]),
		);
		expect(bare(box)).toContain("max-h-full");
		expect(bare(box)).toEqual(expect.arrayContaining(["flex", "flex-col"]));
	});

	it("scrolls its form, under a close button that stays in sight", async () => {
		const { form, box } = await openDialog();
		expect(form.parentElement).toBe(box);
		expect(bare(form)).toContain("overflow-y-auto");
		// The close button is in the title row, outside what scrolls.
		const close = box.querySelector("button");
		expect(close?.closest("form")).toBeNull();
		expect(close?.closest("div")?.parentElement).toBe(box);
	});

	it("leaves every control of the form in reach of its scroll", async () => {
		const { form } = await openDialog();
		const controls = [...form.querySelectorAll<HTMLElement>("input, button")];
		expect(controls.length).toBeGreaterThanOrEqual(4);
		for (const control of controls) {
			for (
				let element = control.parentElement;
				element && element !== form;
				element = element.parentElement
			) {
				expect(
					hidesOverflow(element),
					`${element.className} hides ${control.outerHTML.slice(0, 40)}`,
				).toBe(false);
			}
		}
	});

	it("keeps the banner inside what scrolls when a mailbox already exists", async () => {
		createMailbox.mockRejectedValue({
			response: { data: { error: "Mailbox already exists" } },
		});
		const { field, form } = await openDialog();
		field.value = "taken@example.com";
		field.dispatchEvent(new Event("input"));
		const name = form.querySelector("#mailbox-name") as HTMLInputElement;
		name.value = "Taken";
		name.dispatchEvent(new Event("input"));
		form.dispatchEvent(new Event("submit", { cancelable: true }));
		await settle();
		const banner = form.querySelector("[role=alert]");
		expect(banner?.textContent).toContain("already exists");
	});
});
