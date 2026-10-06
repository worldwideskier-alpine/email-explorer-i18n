import type { JSONContent } from "@tiptap/vue-3";
import { describe, expect, it } from "vitest";
import { boundTables, MAX_TABLE_GRID } from "./editorTables";

/**
 * The tables of one parsed document are held to MAX_TABLE_GRID slots
 * between them, measured the way the editor lays a grid out. Each case here
 * is one the security-guidance review found getting past an earlier, DOM-
 * shaped version of the check.
 */

const cell = (colspan = 1, rowspan = 1): JSONContent => ({
	type: "tableCell",
	attrs: { colspan, rowspan },
	content: [{ type: "paragraph", content: [{ type: "text", text: "c" }] }],
});
const row = (...cells: JSONContent[]): JSONContent => ({
	type: "tableRow",
	content: cells,
});
const table = (...rows: JSONContent[]): JSONContent => ({
	type: "table",
	content: rows,
});
const doc = (...nodes: JSONContent[]): JSONContent => ({
	type: "doc",
	content: nodes,
});
const tablesIn = (node: JSONContent): number =>
	(node.type === "table" ? 1 : 0) +
	(node.content ?? []).reduce((sum, child) => sum + tablesIn(child), 0);

describe("the tables of a quoted document", () => {
	it("are kept while they fit", () => {
		const sheet = table(
			...Array.from({ length: 50 }, () =>
				row(...Array.from({ length: 20 }, () => cell())),
			),
		);
		expect(boundTables(doc(sheet))).toEqual(doc(sheet));
	});

	it("counts the columns a rowspan carries down into the rows below", () => {
		// Every row's own cells add up to 200 columns, but the first row's
		// cell holds 200 more in each row below: 400 by 1,000 is past the
		// budget, though 200 by 1,000 is not.
		const rows = [
			row(cell(200, 1000), cell(200)),
			...Array.from({ length: 999 }, () => row(cell(200))),
		];
		expect(200 * 1000).toBeLessThanOrEqual(MAX_TABLE_GRID);
		expect(400 * 1000).toBeGreaterThan(MAX_TABLE_GRID);
		const out = boundTables(doc(table(...rows)));
		expect(tablesIn(out)).toBe(0);
		expect(out.content).toHaveLength(1000 * 1 + 1);
	});

	it("shares one budget among every table in the document", () => {
		// 100 rows of one 1,000-column cell: 100,000 slots each.
		const big = () =>
			table(...Array.from({ length: 100 }, () => row(cell(1000))));
		const out = boundTables(doc(big(), big(), big()));
		expect(out.content?.map((node) => node.type)).toEqual([
			"table",
			"table",
			...Array(100).fill("paragraph"),
		]);
	});

	it("measures a table nested in a cell against what is left", () => {
		const inner = table(...Array.from({ length: 300 }, () => row(cell(1000))));
		const outer = table(row({ ...cell(), content: [inner] }));
		const out = boundTables(doc(outer));
		expect(tablesIn(out)).toBe(1);
	});
});
