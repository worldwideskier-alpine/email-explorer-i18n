import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, h, nextTick } from "vue";
import { createMemoryHistory, createRouter, RouterView } from "vue-router";
import { useToast } from "@/composables/useToast";
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
 * What a scrolling form costs is given back: a refusal is scrolled into view
 * (it goes in at the top, and Create is at the foot -- 0px of it was shown at
 * 568x320, 667x375 and 740x360), a focus ring keeps its room at the ends, and
 * the scrollbar is drawn dark in dark mode. The toast says the refusal too
 * only when the banner cannot be seen: shown beside it, it said the same
 * words over Create, or the first field, for three seconds on short windows. The row of buttons wraps, since
 * sideways nothing scrolls: at 320px Cancel was cut off in 27 languages.
 *
 * jsdom lays nothing out, so this holds the rules: the dialog is held to its
 * overlay's height at every width, the form is what scrolls and may shrink to
 * do it, the close button is outside it, and nothing between the form and its
 * buttons hides what overflows it or keeps a row from wrapping. Re-measure in
 * a browser after changing it.
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
// jsdom may have no scrollIntoView of its own; whatever it has is put back.
const ownScrollIntoView = Object.getOwnPropertyDescriptor(
	Element.prototype,
	"scrollIntoView",
);
beforeEach(() => {
	host = document.createElement("div");
	document.body.appendChild(host);
	createMailbox.mockReset();
	// One list for the whole module: a toast from the test before would still
	// be up for its three seconds and answer for this one.
	useToast().toasts.value = [];
});
afterEach(() => {
	unmount();
	host.remove();
	document.body.innerHTML = "";
	vi.restoreAllMocks();
	if (ownScrollIntoView) {
		Object.defineProperty(
			Element.prototype,
			"scrollIntoView",
			ownScrollIntoView,
		);
	} else {
		delete (Element.prototype as Partial<Element>).scrollIntoView;
	}
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
	const { default: Toast } = await import("@/components/Toast.vue");
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
	const app = createApp({ render: () => [h(RouterView), h(Toast)] });
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

/** Class names as they apply at every width: only `!` taken off. */
const always = (element: Element) =>
	[...element.classList].map((name) => name.replace(/^!|!$/g, ""));

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
		expect(always(overlay)).toEqual(
			expect.arrayContaining([
				"fixed",
				"inset-0",
				"flex",
				"items-center",
				"p-4",
			]),
		);
		// At every width: `sm:max-h-full` let it run off a phone held sideways.
		expect(always(box)).toContain("max-h-full");
		expect(always(box)).toEqual(expect.arrayContaining(["flex", "flex-col"]));
	});

	it("scrolls its form, under a close button that stays in sight", async () => {
		const { form, box } = await openDialog();
		expect(form.parentElement).toBe(box);
		expect(always(form)).toContain("overflow-y-auto");
		// Free to shrink to what the dialog leaves it, or it is cut off by the
		// dialog instead of scrolling.
		expect(
			bare(form).filter((name) =>
				/^(min-h-|h-|size-|basis-|shrink-0$|flex-shrink-0$|flex-none$)/.test(
					name,
				),
			),
		).toEqual([]);
		// A focus ring keeps its room where the scroll stops at an edge, and
		// the scrollbar is not drawn white on a dark dialog.
		expect(always(form)).toEqual(
			expect.arrayContaining(["scroll-py-6", "dark:[color-scheme:dark]"]),
		);
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
				// Sideways nothing scrolls, so a row of controls wraps.
				const row =
					bare(element).includes("flex") &&
					!bare(element).some((name) => name.startsWith("flex-col"));
				if (row) {
					expect(always(element), `${element.className} wraps`).toContain(
						"flex-wrap",
					);
				}
			}
		}
	});

	/** Submits a name the server refuses as taken. */
	async function refused() {
		createMailbox.mockRejectedValue({
			response: { data: { error: "Mailbox already exists" } },
		});
		const scrolled: Element[] = [];
		Element.prototype.scrollIntoView = function (this: Element) {
			scrolled.push(this);
		};
		const opened = await openDialog();
		const { field, form } = opened;
		field.value = "taken@example.com";
		field.dispatchEvent(new Event("input"));
		const name = form.querySelector("#mailbox-name") as HTMLInputElement;
		name.value = "Taken";
		name.dispatchEvent(new Event("input"));
		form.dispatchEvent(new Event("submit", { cancelable: true }));
		await settle();
		const banner = form.querySelector("[role=alert]");
		const toasts = host.querySelector("div.fixed.bottom-4") as HTMLElement;
		return { ...opened, banner, toasts, scrolled };
	}

	/** Lays the form and its banner out where a test wants them. */
	function laidOut(form: { top: number; bottom: number }, banner: typeof form) {
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
			function (this: HTMLElement) {
				const at =
					this.tagName === "FORM"
						? form
						: this.getAttribute("role") === "alert"
							? banner
							: { top: 0, bottom: 0 };
				return {
					...at,
					left: 0,
					right: 300,
					width: 300,
					height: at.bottom - at.top,
				} as DOMRect;
			},
		);
	}

	it("shows why, scrolled into view, when a mailbox already exists", async () => {
		laidOut({ top: 80, bottom: 300 }, { top: 104, bottom: 152 });
		const { form, banner, scrolled } = await refused();
		expect(banner?.textContent).toContain("already exists");
		expect(banner?.parentElement).toBe(form);
		// It goes in at the top of the form, and Create is at its foot.
		expect(scrolled).toEqual([banner]);
	});

	it("says it in the banner alone when the banner can be seen", async () => {
		laidOut({ top: 80, bottom: 300 }, { top: 104, bottom: 152 });
		const { banner, toasts } = await refused();
		expect(banner?.textContent).toContain("already exists");
		expect(toasts.textContent).not.toContain("already exists");
	});

	for (const [how, lay] of [
		[
			"partly cut off",
			() => laidOut({ top: 80, bottom: 300 }, { top: 280, bottom: 328 }),
		],
		["not laid out", () => {}],
	] as const) {
		it(`says it in a toast as well when the banner is ${how}`, async () => {
			lay();
			const { banner, toasts } = await refused();
			expect(banner?.textContent).toContain("already exists");
			expect(toasts.textContent).toContain("already exists");
		});
	}
});
