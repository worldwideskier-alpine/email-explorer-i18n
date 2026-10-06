import { TableCell, TableHeader } from "@tiptap/extension-table";
import { Fragment, type Node, Slice } from "@tiptap/pm/model";
import { type EditorState, Plugin } from "@tiptap/pm/state";
import { isInTable } from "@tiptap/pm/tables";
import { Extension, type JSONContent } from "@tiptap/vue-3";

/**
 * Table cells whose spans are held to the limits a browser holds them to.
 *
 * A reply or a forward puts the sender's table into the editor, and tiptap
 * read `colspan` and `rowspan` as written: `colspan="999999999"` became that
 * number, and building the table's columns walked it one column at a time.
 * The message itself looked fine -- the frame's browser clamps a colspan to
 * 1000 -- and pressing Reply hung the tab or ran it out of memory, the
 * draft with it (Claude Security F8). These are the HTML standard's own
 * limits, so a table that displays correctly in the message is quoted the
 * same.
 */
export const MAX_COLSPAN = 1000;
export const MAX_ROWSPAN = 65534;

const spanOf = (element: Element, name: "colspan" | "rowspan", max: number) => {
	const value = Number.parseInt(element.getAttribute(name) ?? "", 10);
	return Number.isFinite(value) && value >= 1 ? Math.min(value, max) : 1;
};

const span = (name: "colspan" | "rowspan", max: number) => ({
	default: 1,
	parseHTML: (element: HTMLElement) => spanOf(element, name, max),
});

/**
 * How many slots the tables of one document may have between them -- each
 * table's columns, spans counted, by its rows -- and still be built as
 * tables: a sheet of 50 columns by 5,000 rows.
 *
 * A cap on each cell is not a cap on the table. A thousand cells of a
 * thousand columns each is a million columns; a wide row above many rows is
 * the same; and so are many tables each just under any one table's limit.
 * The editor lays out every slot of every grid. So the grid is measured the
 * way the editor will lay it out -- on the document it parsed, not on the
 * HTML, whose shape a sender controls in ways a parser need not agree with
 * -- and a table past what is left of the budget is not built as a table:
 * its cells' contents are quoted as they are, without it.
 */
export const MAX_TABLE_GRID = 250_000;

/** The slots a table's grid takes, or Infinity once past `budget`. */
function gridSlots(table: JSONContent, budget: number): number {
	const rows = table.content ?? [];
	// How many more rows each column is held for by a rowspan above.
	const carried: number[] = [];
	let width = 0;
	for (const [r, row] of rows.entries()) {
		let column = 0;
		for (const cell of row.content ?? []) {
			while ((carried[column] ?? 0) > 0) column += 1;
			const colspan = Math.max(1, Number(cell.attrs?.colspan) || 1);
			const rowspan = Math.min(
				Math.max(1, Number(cell.attrs?.rowspan) || 1),
				rows.length - r,
			);
			if ((column + colspan) * rows.length > budget)
				return Number.POSITIVE_INFINITY;
			for (let c = column; c < column + colspan; c++) carried[c] = rowspan;
			column += colspan;
		}
		width = Math.max(width, column, carried.length);
		if (width * rows.length > budget) return Number.POSITIVE_INFINITY;
		for (let c = 0; c < carried.length; c++) {
			if ((carried[c] as number) > 0) carried[c] = (carried[c] as number) - 1;
		}
	}
	return width * rows.length;
}

/**
 * The parsed document with every table that does not fit what is left of
 * MAX_TABLE_GRID replaced by its cells' contents. Tables are taken in order,
 * outer before the ones nested in it.
 */
export function boundTables(
	doc: JSONContent,
	budget = MAX_TABLE_GRID,
): JSONContent {
	let left = budget;
	const walk = (nodes: JSONContent[]): JSONContent[] =>
		nodes.flatMap((node) => {
			if (node.type === "table") {
				const slots = gridSlots(node, left);
				if (slots > left) {
					const cells = (node.content ?? []).flatMap(
						(row) => row.content ?? [],
					);
					return walk(cells.flatMap((cell) => cell.content ?? []));
				}
				left -= slots;
			}
			return node.content ? [{ ...node, content: walk(node.content) }] : [node];
		});
	return { ...doc, content: walk(doc.content ?? []) };
}

/**
 * The slots the tables in a document take between them, or Infinity once
 * past `budget`.
 */
function slotsIn(doc: Node, budget = MAX_TABLE_GRID): number {
	let used = 0;
	doc.descendants((node) => {
		if (used > budget) return false;
		if (node.type.name === "table") {
			used += gridSlots(node.toJSON() as JSONContent, budget - used);
		}
		return true;
	});
	return used;
}

/**
 * What is pasted or dropped into the editor, held to what is left of the
 * same budget once the document's own tables are counted. Setting content
 * was not the only way in: a table copied from a message and pasted came in
 * unmeasured (security-guidance, on this change). A slice with nothing
 * replaced is handed back as it was; one with a table taken out is closed,
 * since the depth it was open at may have been that table's.
 */
export function boundPasted(slice: Slice, state: EditorState): Slice {
	const { doc } = state;
	// Into a table, a pasted table is pasted as its cells' contents. Merged
	// in as cells, it grew the table it landed in to cover both, and growing
	// it was the expensive part, done before anything could measure the
	// result (security-guidance, on this change).
	// Asked the way prosemirror-tables asks before it merges cells, so the two
	// cannot disagree about where the paste lands: a selection made backwards
	// out of a table had its start outside it and its head in it.
	const left = isInTable(state)
		? 0
		: Math.max(0, MAX_TABLE_GRID - slotsIn(doc));
	const pasted = { type: "doc", content: slice.content.toJSON() ?? [] };
	const bounded = boundTables(pasted, left);
	if (JSON.stringify(bounded) === JSON.stringify(pasted)) return slice;
	return new Slice(
		Fragment.fromJSON(doc.type.schema, bounded.content ?? []),
		0,
		0,
	);
}

export const BoundedTableCell = TableCell.extend({
	addAttributes() {
		return {
			...this.parent?.(),
			colspan: span("colspan", MAX_COLSPAN),
			rowspan: span("rowspan", MAX_ROWSPAN),
		};
	},
});

export const BoundedTableHeader = TableHeader.extend({
	addAttributes() {
		return {
			...this.parent?.(),
			colspan: span("colspan", MAX_COLSPAN),
			rowspan: span("rowspan", MAX_ROWSPAN),
		};
	},
});

/**
 * The last word: no change to the document may leave its tables past
 * MAX_TABLE_GRID, whatever made the change. Content set, pasted or dropped
 * is bounded before it gets here, so this refuses only what came some other
 * way -- a command, a table edited a row at a time.
 */
export const TableBudget = Extension.create({
	name: "tableBudget",
	addProseMirrorPlugins() {
		return [
			new Plugin({
				filterTransaction: (tr) =>
					!tr.docChanged || slotsIn(tr.doc) <= MAX_TABLE_GRID,
			}),
		];
	},
});
