import { afterEach, describe, expect, it } from "vitest";
import { createApp, h, nextTick } from "vue";
import { createI18n } from "vue-i18n";
import { MAX_COLSPAN, MAX_ROWSPAN, MAX_TABLE_GRID } from "@/utils/editorTables";
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
	for (let i = 0; i < 20 && !host.querySelector(".ProseMirror > *"); i++) {
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

/**
 * A cap on each cell is not a cap on the table: a thousand cells of a
 * thousand columns each is a million columns, and the editor built them one
 * at a time all the same. So a table whose grid -- columns by rows, spans
 * counted -- is past what any message needs is not built as a table at all;
 * its text is quoted as text. (security-guidance, on this change.)
 */
describe("a quoted table too large to be one", () => {
	it("is quoted as its text, and the editor opens at once", async () => {
		const cells = '<td colspan="1000">c</td>'.repeat(1000);
		const started = performance.now();
		const { host, app } = await drawn(
			`<table><tr>${cells}</tr></table><p>after</p>`,
		);
		expect(performance.now() - started).toBeLessThan(5000);
		expect(host.querySelector(".ProseMirror table")).toBeNull();
		expect(host.querySelector(".ProseMirror")?.textContent).toContain("after");
		expect(1000 * MAX_COLSPAN).toBeGreaterThan(MAX_TABLE_GRID);
		app.unmount();
	}, 30_000);

	it("counts a wide row above many rows the same way, spans or none", async () => {
		const wide = `<tr>${"<td>w</td>".repeat(1000)}</tr>`;
		const narrow = "<tr><td>n</td></tr>".repeat(1000);
		const started = performance.now();
		const { host, app } = await drawn(`<table>${wide}${narrow}</table>`);
		expect(performance.now() - started).toBeLessThan(5000);
		expect(host.querySelector(".ProseMirror table")).toBeNull();
		app.unmount();
	}, 30_000);

	it("stays a table while its grid is within bounds", async () => {
		const row = `<tr>${"<td>c</td>".repeat(20)}</tr>`;
		const { host, app } = await drawn(`<table>${row.repeat(50)}</table>`);
		expect(host.querySelectorAll(".ProseMirror tr")).toHaveLength(50);
		app.unmount();
	});
});
