/**
 * Where a small panel opened from a button goes when it is drawn over the
 * whole page (`position: fixed`), outside any box that would cut it off.
 *
 * Below the button by preference, and above it when there is no room below
 * but there is above; lined up with the button's start edge (its right edge
 * when the page reads right to left); and kept inside the window with a small
 * margin, so a button near the window's edge does not push the panel past it.
 * A panel larger than the window is put at the margin and left to overflow
 * past the far edge, since some of it showing beats none of it.
 */

export interface Anchor {
	top: number;
	bottom: number;
	left: number;
	right: number;
}

export interface Size {
	width: number;
	height: number;
}

export function placeFromButton(
	button: Anchor,
	panel: Size,
	viewport: Size,
	rightToLeft: boolean,
	gap = 4,
	margin = 8,
): { top: number; left: number } {
	// The low end wins over the high one: a panel larger than the window
	// starts at the margin.
	const clamp = (value: number, low: number, high: number) =>
		Math.max(low, Math.min(value, high));

	const below = button.bottom + gap;
	const above = button.top - gap - panel.height;
	const fitsBelow = below + panel.height <= viewport.height - margin;
	const fitsAbove = above >= margin;
	const top =
		fitsBelow || !fitsAbove
			? clamp(below, margin, viewport.height - margin - panel.height)
			: above;

	const start = rightToLeft ? button.right - panel.width : button.left;
	const left = clamp(start, margin, viewport.width - margin - panel.width);

	return { top, left };
}

/**
 * Whether the button such a panel was opened from can still be seen: its
 * middle inside the window and inside every box around it that cuts off what
 * overflows it (`clips`). A panel drawn over the page does not scroll out of
 * sight with its button, as one hung from the button did, so it is hidden
 * while the button is: kept in the window by `placeFromButton`, it stayed at
 * the window's edge over the header or a Save button, and took their clicks
 * as a colour.
 */
export function buttonInSight(
	button: Anchor,
	clips: readonly Anchor[],
	viewport: Size,
): boolean {
	const x = (button.left + button.right) / 2;
	const y = (button.top + button.bottom) / 2;
	const inside = (box: Anchor) =>
		x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
	return (
		inside({
			top: 0,
			left: 0,
			right: viewport.width,
			bottom: viewport.height,
		}) && clips.every(inside)
	);
}
