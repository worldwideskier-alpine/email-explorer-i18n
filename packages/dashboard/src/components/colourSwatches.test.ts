import { afterEach, describe, expect, it } from "vitest";
import { createApp, h, nextTick } from "vue";
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
 * (popupPlacement.test.ts), above the compose dialog, placed again when a
 * scroll or a resize moves the button, and closed by a click elsewhere or
 * Escape. Not closed by a scroll or a resize: a phone's keyboard going away
 * is one, and the swatches went with their button before. jsdom lays nothing
 * out, so where they land is held by popupPlacement.test.ts and the
 * measurements above; this holds the rest.
 */

async function drawn() {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const app = createApp({
		setup: () => () => h(RichTextEditor, { modelValue: "<p>words</p>" }),
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
	app.mount(host);
	for (let i = 0; i < 20 && !host.querySelector(".ProseMirror p"); i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await nextTick();
	}
	return { host, app };
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

afterEach(() => {
	document.body.innerHTML = "";
});

describe("the colour swatches", () => {
	it("are drawn over the whole page, as wide as they are, outside the editor", async () => {
		const { host, app } = await drawn();
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
		expect(open?.querySelectorAll("button")).toHaveLength(15);
		app.unmount();
	});

	it("give the text the colour pressed, and close", async () => {
		const { host, app } = await drawn();
		const word = host.querySelector(".ProseMirror p") as HTMLElement;
		(host.querySelector(".ProseMirror") as HTMLElement).focus();
		const range = document.createRange();
		range.selectNodeContents(word);
		getSelection()?.removeAllRanges();
		getSelection()?.addRange(range);
		// ProseMirror reads the page's selection when the page says it moved.
		document.dispatchEvent(new Event("selectionchange"));
		await settle();
		toggle(host, "textColor").click();
		await settle();
		const red = panel()?.querySelector('button[title="#FF0000"]');
		expect(red, "the red swatch").toBeInstanceOf(HTMLElement);
		(red as HTMLElement).click();
		await settle();
		expect(panel()).toBeNull();
		expect(host.querySelector(".ProseMirror [style]")).not.toBeNull();
		app.unmount();
	});

	it("are the highlights from the other button, and switch between the two", async () => {
		const { host, app } = await drawn();
		toggle(host, "textColor").click();
		await settle();
		toggle(host, "highlight").click();
		await settle();
		expect(
			document.body.querySelectorAll("[data-colour-swatches]"),
		).toHaveLength(1);
		expect(panel()?.querySelectorAll("button")).toHaveLength(10);
		toggle(host, "highlight").click();
		await settle();
		expect(panel()).toBeNull();
		app.unmount();
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
			const { host, app } = await drawn();
			toggle(host, "textColor").click();
			await settle();
			expect(panel()).not.toBeNull();
			close();
			await settle();
			expect(panel()).toBeNull();
			app.unmount();
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
	] as const) {
		it(`go with their button on ${how}, and stay open`, async () => {
			const { host, app } = await drawn();
			const button = toggle(host, "textColor");
			let at = { left: 40, top: 100 };
			button.getBoundingClientRect = () =>
				({
					...at,
					right: at.left + 32,
					bottom: at.top + 32,
					width: 32,
					height: 32,
				}) as DOMRect;
			button.click();
			await settle();
			expect(panel()?.style.top).toBe("136px");
			at = { left: 60, top: 300 };
			move();
			await settle();
			expect(panel(), "still open").not.toBeNull();
			expect(panel()?.style.top).toBe("336px");
			expect(panel()?.style.left).toBe("60px");
			app.unmount();
		});
	}

	it("stay open on a click among them that is not a swatch", async () => {
		const { host, app } = await drawn();
		toggle(host, "highlight").click();
		await settle();
		panel()?.click();
		await settle();
		expect(panel()).not.toBeNull();
		app.unmount();
	});

	it("go with the editor", async () => {
		const { host, app } = await drawn();
		toggle(host, "textColor").click();
		await settle();
		app.unmount();
		await settle();
		expect(panel()).toBeNull();
	});
});
