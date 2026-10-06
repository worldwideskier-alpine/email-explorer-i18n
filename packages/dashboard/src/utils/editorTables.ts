import {
	Table,
	TableCell,
	TableHeader,
	TableRow,
} from "@tiptap/extension-table";

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
 * How many slots a table's grid may have -- columns, spans counted, by rows
 * -- and still be built as a table: a sheet of 50 columns by 5,000 rows.
 *
 * A cap on each cell is not a cap on the table. A thousand cells of a
 * thousand columns each is a million columns, built one at a time all the
 * same, and so is a row of many cells above many rows of one; the editor
 * lays out every slot of the grid. A table past this is not a table any
 * message needs, and its text is quoted as text instead.
 */
export const MAX_TABLE_GRID = 250_000;

const fits = new WeakMap<Element, boolean>();

function fitsTheEditor(table: HTMLElement): boolean {
	const known = fits.get(table);
	if (known !== undefined) return known;
	const rows = (table as HTMLTableElement).rows ?? [];
	let width = 0;
	for (const row of rows) {
		let columns = 0;
		for (const cell of row.cells) {
			columns += spanOf(cell, "colspan", MAX_COLSPAN);
		}
		width = Math.max(width, columns);
	}
	const answer = width * rows.length <= MAX_TABLE_GRID;
	fits.set(table, answer);
	return answer;
}

/** Whether an element of a table belongs to one too large to be one. */
const inOversized = (element: HTMLElement) => {
	const table = element.closest("table");
	return !!table && !fitsTheEditor(table);
};

/**
 * The same rules, refusing anything inside an oversized table. Refusing the
 * `<table>` alone is not enough: its rows and cells were still read, and the
 * parser wrapped them back into a table of the same size.
 */
const refusingOversized = <
	Rule extends { getAttrs?: (element: HTMLElement) => unknown },
>(
	rules: readonly Rule[] | undefined,
): Rule[] =>
	(rules ?? []).map(
		(rule) =>
			({
				...rule,
				getAttrs: (element: HTMLElement) =>
					inOversized(element)
						? false
						: rule.getAttrs
							? rule.getAttrs(element)
							: null,
			}) as Rule,
	);

/** A table, unless its grid is past MAX_TABLE_GRID; then its contents. */
export const BoundedTable = Table.extend({
	parseHTML() {
		return refusingOversized(this.parent?.());
	},
});

export const BoundedTableRow = TableRow.extend({
	parseHTML() {
		return refusingOversized(this.parent?.());
	},
});

export const BoundedTableCell = TableCell.extend({
	parseHTML() {
		return refusingOversized(this.parent?.());
	},
	addAttributes() {
		return {
			...this.parent?.(),
			colspan: span("colspan", MAX_COLSPAN),
			rowspan: span("rowspan", MAX_ROWSPAN),
		};
	},
});

export const BoundedTableHeader = TableHeader.extend({
	parseHTML() {
		return refusingOversized(this.parent?.());
	},
	addAttributes() {
		return {
			...this.parent?.(),
			colspan: span("colspan", MAX_COLSPAN),
			rowspan: span("rowspan", MAX_ROWSPAN),
		};
	},
});
