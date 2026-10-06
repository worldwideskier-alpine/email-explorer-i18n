import { afterEach, describe, expect, it } from "vitest";
import { createApp, h, nextTick } from "vue";
import { createI18n } from "vue-i18n";
import { MAX_COLSPAN, MAX_ROWSPAN } from "@/utils/editorTables";
import RichTextEditor from "./RichTextEditor.vue";

/**
 * A table quoted from the message being replied to keeps its spans only up
 * to the limits a browser holds them to (Claude Security F8). Read as
 * written, `colspan="999999999"` made the editor build that many columns one
 * at a time, and pressing Reply hung the tab.
 */

async function drawn(content: string) {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const app = createApp({
		setup: () => () => h(RichTextEditor, { modelValue: content }),
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
	for (let i = 0; i < 20 && !host.querySelector(".ProseMirror table"); i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await nextTick();
	}
	return { host, app };
}

afterEach(() => {
	document.body.innerHTML = "";
});

const cell = (host: Element, tag = "td") =>
	host.querySelector(`.ProseMirror ${tag}`) as HTMLElement;

describe("a quoted table's spans", () => {
	it("are held to the browser's limits, and the editor opens at once", async () => {
		const started = performance.now();
		const { host, app } = await drawn(
			'<table><tr><th colspan="999999999" rowspan="999999999">h</th></tr><tr><td colspan="999999999">x</td></tr></table>',
		);
		expect(performance.now() - started).toBeLessThan(3000);
		expect(cell(host, "th").getAttribute("colspan")).toBe(String(MAX_COLSPAN));
		expect(cell(host, "th").getAttribute("rowspan")).toBe(String(MAX_ROWSPAN));
		expect(cell(host).getAttribute("colspan")).toBe(String(MAX_COLSPAN));
		app.unmount();
	});

	it("are kept as written when they are sensible", async () => {
		const { host, app } = await drawn(
			'<table><tr><td colspan="2" rowspan="3">a</td><td>b</td></tr></table>',
		);
		expect(cell(host).getAttribute("colspan")).toBe("2");
		expect(cell(host).getAttribute("rowspan")).toBe("3");
		app.unmount();
	});

	it("fall back to one when they are not numbers", async () => {
		const { host, app } = await drawn(
			'<table><tr><td colspan="x" rowspan="0">a</td></tr></table>',
		);
		expect(cell(host).getAttribute("colspan")).toBe("1");
		expect(cell(host).getAttribute("rowspan")).toBe("1");
		app.unmount();
	});
});
