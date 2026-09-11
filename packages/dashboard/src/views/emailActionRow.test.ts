import { describe, expect, it } from "vitest";

/**
 * The row of actions on an open message stays one row.
 *
 * It used to wrap, and what wrapped was the last action in the row -- delete,
 * alone on a second line under the other eight, on every phone and on a
 * tablet. The cause was not the phone being narrow: the row and the subject
 * were bidding for the same width, and `flex-wrap` let the row be the one
 * that gave, because a wrapping row is allowed to ask for less.
 *
 * What holds it now is two things together, and either alone brings the row
 * back: the row does not wrap, so the subject truncates instead; and each
 * action is `flex-1`, so nine of them share whatever width there is rather
 * than each claiming a fixed 40px that only a desktop has.
 *
 * Measured in a browser against the built stylesheet, in the container chain
 * the real page puts around it (main > card > header): one line at 320, 360,
 * 375, 390, 414, 640, 768 and 1280, with the buttons coming out at 27, 31,
 * 33, 35, 37, 40, 40 and 40px and nothing hanging past the card at any of
 * them. With the old classes it was two lines at every one of those but 1280.
 * 320 used to be one line and 14px wider than the card; the padding below
 * `sm` came down to `p-0.5` for WCAG 1.4.10, which `reflow320.test.ts`
 * records, and that is where the 27 comes from. Layout is not
 * something vitest can see, so what is held here is the arrangement that
 * produced those numbers.
 *
 * Sources come from import.meta.glob rather than node:fs, for the reason
 * formContrast.test.ts documents: src/ is type-checked without Node types.
 */

const emailDetail = Object.values(
	import.meta.glob("./EmailDetail.vue", {
		query: "?raw",
		import: "default",
		eager: true,
	}) as Record<string, string>,
)[0];

/** The action row: from its own opening tag to the sender row that follows. */
const actionRow = (() => {
	const end = emailDetail.indexOf(
		'<div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-0 mt-6">',
	);
	// The last such row before the sender block: the first one is the subject
	// and its back button, which is not what this is about.
	const start = emailDetail.lastIndexOf(
		'<div class="flex items-center gap-',
		end,
	);
	if (start < 0 || end <= start) {
		throw new Error("EmailDetail.vue: the action row is no longer findable");
	}
	return emailDetail.slice(start, end);
})();

/** Its opening tag, i.e. the classes on the row itself rather than on a child. */
const rowClasses = /^<div class="([^"]*)"/.exec(actionRow)?.[1] ?? "";

describe("the actions on an open message", () => {
	it("is a row that does not wrap", () => {
		expect(rowClasses).toContain("flex-nowrap");
		expect(rowClasses).not.toContain("flex-wrap");
	});

	/**
	 * Ten in the file, nine on screen: "not spam" and "mark as spam" are the
	 * two halves of one v-if/v-else and only ever one is rendered.
	 *
	 * The count is pinned because it is the whole budget. An action cannot go
	 * below 24px -- 20px of icon and the 2px either side that keeps it from
	 * touching its neighbour -- so nine of them and the gaps between need
	 * 232px of row, which is a viewport of about 298px once the page's padding
	 * and the card's are taken off. That leaves 320px with a little room. A
	 * tenth action costs 26px and puts the floor back above 320, where the row
	 * is clipped by the card rather than wrapped -- the lesser of the two, but
	 * a WCAG 1.4.10 failure all the same, and nothing else in the arrangement
	 * would say so. An action added here is a measurement, not an edit.
	 */
	it("is nine actions wide", () => {
		const controls = actionRow.match(/<(?:button|router-link)\b/g) ?? [];
		// The folders the move menu lists are buttons too, and are not actions
		// in this row; they live in the dropdown.
		const inMenu =
			actionRow.match(/<button v-for="folder in moveToFolders"/g) ?? [];
		expect(controls.length - inMenu.length).toBe(10);
	});

	it("lets every action size itself to the space there is", () => {
		// One flex-1 per action. The move menu's own is on the wrapper the
		// dropdown is positioned against, not on the button inside it, which
		// is why the button takes w-full instead.
		const shares = actionRow.match(/\bflex-1\b/g) ?? [];
		expect(shares.length).toBe(10);
		expect(actionRow).toContain('<div class="relative flex-1" ref="moveMenu">');
		expect(actionRow).toContain("flex w-full items-center justify-center");
	});

	it("keeps the icons 20px whatever the button comes out at", () => {
		// The button shrinks on a phone by giving up its padding; the icon
		// inside it is what makes the row readable and does not shrink.
		const icons = actionRow.match(/class="h-5 w-5"/g) ?? [];
		expect(icons.length).toBeGreaterThanOrEqual(10);
		expect(actionRow).not.toMatch(/class="h-4 w-4"/);
	});
});
