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
	window: Size,
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
	const fitsBelow = below + panel.height <= window.height - margin;
	const fitsAbove = above >= margin;
	const top =
		fitsBelow || !fitsAbove
			? clamp(below, margin, window.height - margin - panel.height)
			: above;

	const start = rightToLeft ? button.right - panel.width : button.left;
	const left = clamp(start, margin, window.width - margin - panel.width);

	return { top, left };
}
