import { TableCell, TableHeader } from "@tiptap/extension-table";

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

const span = (name: "colspan" | "rowspan", max: number) => ({
	default: 1,
	parseHTML: (element: HTMLElement) => {
		const value = Number.parseInt(element.getAttribute(name) ?? "", 10);
		return Number.isFinite(value) && value >= 1 ? Math.min(value, max) : 1;
	},
});

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
