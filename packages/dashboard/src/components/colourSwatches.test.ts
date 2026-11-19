import { afterEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick } from "vue";
import { createI18n } from "vue-i18n";
import RichTextEditor from "./RichTextEditor.vue";

/**
 * The editor's colour swatches can be pressed, all of them, wherever the
 * editor is.
 *
 * They hung below their button (`absolute top-full`) inside a wrapper as
 * wide as the button. An absolute grid with no width of its own takes its
 * containing block's, so the five columns shared about 32px and the 24px
 * swatches lay over one another; and the editor hides its overflow, as does
 * the compose dialog, so what hung past them was cut off. Measured in
 * Chromium, in Japanese and Arabic, swatches a person could press, before ->
 * after:
 *
 *   compose, 1366x768, 1024x768, 320x568   3 of 15 text, 2 of 10 highlight
 *   compose, 375x667                       0 of 15, 0 of 10
 *   Settings signature, at those sizes     1-2 of 15, 1-2 of 10
 *                                                    -> all of them, at all
 *
 * Now they are drawn over the whole page (teleported to <body>, fixed), as
 * wide as their swatches (w-max), placed from the button
 * (popupPlacement.test.ts) and above the compose dialog. Out of the page's
 * flow they lost three things the old place gave for free, each held here:
 * going with the button (placed again on a scroll, a resize or the end of a
 * transition, and not closed by them, since a phone's keyboard going away is
 * one), going out of sight with it (hidden while it is, or they stayed at the
 * window's edge over other controls and took their clicks), and coming next
 * in the Tab order (a keyboard that opens them is moved in, and back to the
 * button when it leaves). jsdom lays nothing out, so where they land is held
 * by popupPlacement.test.ts and the measurements above; this holds the rest.
 */

let mounted: App | undefined;

async function drawn(count = 1) {
	const hosts: HTMLElement[] = [];
	const app = createApp({
		setup: () => () =>
			Array.from({ length: count }, () =>
				h(RichTextEditor, { modelValue: "<p>words</p>" }),
			),
	});
	app.use(
		createI18n({
			legacy: false,
			locale: "en",
			messages: { en: {} },
			missingWarn: false,
			fallbackWarn: false,
		}),
	);
	const host = document.createElement("div");
	document.body.appendChild(host);
	app.mount(host);
	mounted = app;
	for (let i = 0; i < 20 && !host.querySelector(".ProseMirror p"); i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await nextTick();
	}
	hosts.push(...host.querySelectorAll<HTMLElement>(".rich-text-editor"));
	return { host, hosts };
}

/** Unmount now, rather than after the test. */
function unmount() {
	mounted?.unmount();
	mounted = undefined;
}

const settle = async () => {
	for (let i = 0; i < 4; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await nextTick();
	}
};

const toggle = (host: Element, which: "textColor" | "highlight") =>
	host.querySelector(
		`button[title="richTextEditor.${which}"]`,
	) as HTMLButtonElement;

const panel = () =>
	document.body.querySelector("[data-colour-swatches]") as HTMLElement | null;

const swatches = () => [
	...(panel()?.querySelectorAll<HTMLButtonElement>("button") ?? []),
];

/** A click a pointer made, as opposed to `.click()` or a key (detail 0). */
const pointerClick = (element: Element) =>
	element.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));

/** Puts a button where a test wants it, as the layout jsdom lacks would. */
function placeAt(button: Element, at: { left: number; top: number }) {
	button.getBoundingClientRect = () =>
		({
			...at,
			right: at.left + 32,
			bottom: at.top + 32,
			width: 32,
			height: 32,
		}) as DOMRect;
}

async function selectWord(host: Element) {
	const word = host.querySelector(".ProseMirror p") as HTMLElement;
	(host.querySelector(".ProseMirror") as HTMLElement).focus();
	const range = document.createRange();
	range.selectNodeContents(word);
	getSelection()?.removeAllRanges();
	getSelection()?.addRange(range);
	// ProseMirror reads the page's selection when the page says it moved.
	document.dispatchEvent(new Event("selectionchange"));
	await settle();
}

afterEach(() => {
	unmount();
	document.body.innerHTML = "";
	vi.restoreAllMocks();
});

describe("the colour swatches", () => {
	it("are drawn over the whole page, as wide as they are, outside the editor", async () => {
		const { host } = await drawn();
		toggle(host, "textColor").click();
		await settle();

		const open = panel();
		expect(open, "the swatches").not.toBeNull();
		// Not inside the editor, whose overflow-hidden cut them off.
		expect(host.contains(open)).toBe(false);
		expect(open?.parentElement).toBe(document.body);
		const classes = [...(open?.classList ?? [])];
		expect(classes).toEqual(
			expect.arrayContaining(["fixed", "w-max", "z-[60]"]),
		);
		expect(classes.filter((name) => name.startsWith("absolute"))).toEqual([]);
		// Placed, and shown once placed.
		expect(open?.style.visibility).not.toBe("hidden");
		expect(open?.style.top).toMatch(/px$/);
		expect(open?.style.left).toMatch(/px$/);
		expect(swatches()).toHaveLength(15);
	});

	it("give the text the colour pressed, and close", async () => {
		const { host } = await drawn();
		await selectWord(host);
		pointerClick(toggle(host, "textColor"));
		await settle();
		const red = swatches().find((swatch) => swatch.title === "#FF0000");
		expect(red, "the red swatch").toBeInstanceOf(HTMLElement);
		red?.click();
		await settle();
		expect(panel()).toBeNull();
		expect(
			host.querySelector(".ProseMirror [style]")?.getAttribute("style"),
		).toMatch(/color/);
	});

	it("give the text the highlight pressed from the other button, and close", async () => {
		const { host } = await drawn();
		await selectWord(host);
		pointerClick(toggle(host, "highlight"));
		await settle();
		const titles = swatches().map((swatch) => swatch.title);
		expect(titles).toHaveLength(10);
		expect(titles).toContain("#ADD8E6");
		expect(titles).not.toContain("#FF0000");
		swatches()
			.find((swatch) => swatch.title === "#ADD8E6")
			?.click();
		await settle();
		expect(panel()).toBeNull();
		expect(host.querySelector(".ProseMirror mark")).not.toBeNull();
		expect(host.querySelector(".ProseMirror span[style]")).toBeNull();
	});

	it("are placed from the button they were opened from, and switch between the two", async () => {
		const { host } = await drawn();
		placeAt(toggle(host, "textColor"), { left: 40, top: 100 });
		placeAt(toggle(host, "highlight"), { left: 80, top: 100 });
		pointerClick(toggle(host, "textColor"));
		await settle();
		expect(panel()?.style.left).toBe("40px");
		pointerClick(toggle(host, "highlight"));
		await settle();
		expect(
			document.body.querySelectorAll("[data-colour-swatches]"),
		).toHaveLength(1);
		expect(swatches()).toHaveLength(10);
		expect(panel()?.style.left).toBe("80px");
		pointerClick(toggle(host, "highlight"));
		await settle();
		expect(panel()).toBeNull();
	});

	it("line up with the button's other edge on a page read right to left", async () => {
		const { host } = await drawn();
		const button = toggle(host, "textColor");
		placeAt(button, { left: 40, top: 100 });
		button.style.direction = "rtl";
		pointerClick(button);
		await settle();
		// jsdom gives the panel no width, so its right edge is its left.
		expect(panel()?.style.left).toBe("72px");
	});

	for (const [how, close] of [
		["a click elsewhere", () => document.body.click()],
		[
			"Escape",
			() =>
				window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })),
		],
	] as const) {
		it(`close on ${how}`, async () => {
			const { host } = await drawn();
			pointerClick(toggle(host, "textColor"));
			await settle();
			expect(panel()).not.toBeNull();
			close();
			await settle();
			expect(panel()).toBeNull();
		});
	}

	for (const [how, move] of [
		[
			"a scroll anywhere",
			() =>
				document
					.querySelector(".ProseMirror")
					?.dispatchEvent(new Event("scroll")),
		],
		["a resize", () => window.dispatchEvent(new Event("resize"))],
		[
			"the end of a transition",
			() =>
				document.body.dispatchEvent(
					new Event("transitionend", { bubbles: true }),
				),
		],
	] as const) {
		it(`go with their button on ${how}, and stay open`, async () => {
			const { host } = await drawn();
			const button = toggle(host, "textColor");
			placeAt(button, { left: 40, top: 100 });
			pointerClick(button);
			await settle();
			expect(panel()?.style.top).toBe("136px");
			placeAt(button, { left: 60, top: 300 });
			move();
			await settle();
			expect(panel(), "still open").not.toBeNull();
			expect(panel()?.style.top).toBe("336px");
			expect(panel()?.style.left).toBe("60px");
		});
	}

	it("go out of sight with their button, and come back with it", async () => {
		const { host } = await drawn();
		const button = toggle(host, "textColor");
		placeAt(button, { left: 40, top: 100 });
		pointerClick(button);
		await settle();
		const scroll = async () => {
			window.dispatchEvent(new Event("scroll"));
			await settle();
		};

		// Scrolled off the top of the window.
		placeAt(button, { left: 40, top: -200 });
		await scroll();
		expect(panel(), "hidden, not closed").not.toBeNull();
		expect(panel()?.style.visibility).toBe("hidden");

		// Back in sight.
		placeAt(button, { left: 40, top: 100 });
		await scroll();
		expect(panel()?.style.visibility).not.toBe("hidden");
		expect(panel()?.style.top).toBe("136px");

		// In the window, but cut off by a box around it that scrolls.
		host.style.overflowY = "auto";
		host.getBoundingClientRect = () =>
			({ top: 200, bottom: 600, left: 0, right: 1024 }) as DOMRect;
		await scroll();
		expect(panel()?.style.visibility).toBe("hidden");
		host.getBoundingClientRect = () =>
			({ top: 50, bottom: 600, left: 0, right: 1024 }) as DOMRect;
		await scroll();
		expect(panel()?.style.visibility).not.toBe("hidden");
	});

	it("take a keyboard that opens them, and give it back to the button", async () => {
		const { host } = await drawn();
		const button = toggle(host, "textColor");

		// Opened by a pointer: the focus stays where it was.
		pointerClick(button);
		await settle();
		expect(panel()?.contains(document.activeElement)).toBe(false);
		pointerClick(button);
		await settle();

		// Opened by a key (a click with detail 0): the first swatch, and only
		// once the swatches are shown -- a browser gives no focus inside
		// visibility: hidden, which jsdom does not know.
		const shownWhenFocused: string[] = [];
		const focus = HTMLElement.prototype.focus;
		vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (
			this: HTMLElement,
			options?: FocusOptions,
		) {
			const holder = this.closest<HTMLElement>("[data-colour-swatches]");
			if (holder) shownWhenFocused.push(holder.style.visibility);
			focus.call(this, options);
		});
		button.click();
		await settle();
		expect(document.activeElement).toBe(swatches()[0]);
		expect(shownWhenFocused).toEqual([""]);
		vi.mocked(HTMLElement.prototype.focus).mockRestore();

		// Shift+Tab before the first swatch: back to the button, closed.
		const tab = (from: Element, shiftKey: boolean) =>
			from.dispatchEvent(
				new KeyboardEvent("keydown", {
					key: "Tab",
					shiftKey,
					bubbles: true,
					cancelable: true,
				}),
			);
		expect(tab(swatches()[0], true), "the browser's own Tab is not taken").toBe(
			false,
		);
		await settle();
		expect(panel()).toBeNull();
		expect(document.activeElement).toBe(button);

		// Tab past the last one: the same.
		button.click();
		await settle();
		const last = swatches()[swatches().length - 1];
		last.focus();
		expect(
			tab(swatches()[3], false),
			"Tab between swatches is left alone",
		).toBe(true);
		tab(last, false);
		await settle();
		expect(panel()).toBeNull();
		expect(document.activeElement).toBe(button);

		// Escape from inside them: the same.
		button.click();
		await settle();
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		await settle();
		expect(panel()).toBeNull();
		expect(document.activeElement).toBe(button);

		// Escape with the focus elsewhere closes them and moves nothing.
		pointerClick(button);
		await settle();
		const elsewhere = document.body.appendChild(
			document.createElement("input"),
		);
		elsewhere.focus();
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		await settle();
		expect(panel()).toBeNull();
		expect(document.activeElement).toBe(elsewhere);
	});

	it("stay open on a click among them that is not a swatch", async () => {
		const { host } = await drawn();
		pointerClick(toggle(host, "highlight"));
		await settle();
		panel()?.click();
		await settle();
		expect(panel()).not.toBeNull();
	});

	it("of one editor close when another editor's are opened", async () => {
		const { hosts } = await drawn(2);
		expect(hosts).toHaveLength(2);
		const [first, second] = hosts;
		pointerClick(toggle(first, "textColor"));
		await settle();
		pointerClick(toggle(second, "highlight"));
		await settle();
		expect(
			document.body.querySelectorAll("[data-colour-swatches]"),
		).toHaveLength(1);
		expect(swatches()).toHaveLength(10);
	});

	it("go with the editor, and leave no listener behind", async () => {
		const added: unknown[][] = [];
		const removed: unknown[][] = [];
		const add = window.addEventListener.bind(window);
		const remove = window.removeEventListener.bind(window);
		vi.spyOn(window, "addEventListener").mockImplementation((...args) => {
			added.push([args[0], args[1], Boolean(args[2])]);
			add(...(args as Parameters<typeof add>));
		});
		vi.spyOn(window, "removeEventListener").mockImplementation((...args) => {
			removed.push([args[0], args[1], Boolean(args[2])]);
			remove(...(args as Parameters<typeof remove>));
		});
		const { host } = await drawn();
		pointerClick(toggle(host, "textColor"));
		await settle();
		const ours = (list: unknown[][]) =>
			list.filter(([type]) =>
				["click", "keydown", "scroll", "resize", "transitionend"].includes(
					type as string,
				),
			);
		expect(ours(added).length).toBeGreaterThanOrEqual(5);
		unmount();
		await settle();
		expect(panel()).toBeNull();
		for (const listener of ours(added)) {
			expect(removed, `${String(listener[0])} removed`).toContainEqual(
				listener,
			);
		}
	});
});
