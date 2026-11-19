import { describe, expect, it } from "vitest";
import { buttonInSight, placeFromButton } from "./popupPlacement";

const viewport = { width: 375, height: 667 };
const panel = { width: 154, height: 98 };
const button = (left: number, top: number) => ({
	left,
	right: left + 32,
	top,
	bottom: top + 32,
});

describe("a panel opened from a button", () => {
	it("goes below the button, lined up with its start", () => {
		expect(placeFromButton(button(40, 100), panel, viewport, false)).toEqual({
			top: 136,
			left: 40,
		});
	});

	it("lines up with the button's right edge when the page reads right to left", () => {
		expect(placeFromButton(button(200, 100), panel, viewport, true)).toEqual({
			top: 136,
			left: 232 - 154,
		});
	});

	it("goes above the button when there is no room below and room above", () => {
		expect(placeFromButton(button(40, 600), panel, viewport, false)).toEqual({
			top: 600 - 4 - 98,
			left: 40,
		});
	});

	it("stays inside the window when the button is near its end", () => {
		// The measured case: at 375x667 the text-colour button starts at 248px,
		// and a 154px panel lined up with it would end at 402px, past the window.
		const { left } = placeFromButton(button(330, 100), panel, viewport, false);
		expect(left).toBe(375 - 8 - 154);
		expect(placeFromButton(button(0, 100), panel, viewport, true).left).toBe(8);
	});

	it("stays inside the window when there is room neither below nor above", () => {
		const short = { width: 375, height: 150 };
		const { top } = placeFromButton(button(40, 50), panel, short, false);
		expect(top).toBeGreaterThanOrEqual(8);
		expect(top + panel.height).toBeLessThanOrEqual(150 - 8 + 0.5);
	});

	it("starts at the margin when the panel is larger than the window", () => {
		expect(
			placeFromButton(
				button(40, 20),
				{ width: 400, height: 700 },
				viewport,
				false,
			),
		).toEqual({ top: 8, left: 8 });
	});
});

describe("the button a panel was opened from", () => {
	const at = button(40, 100);

	it("is in sight when its middle is inside the window and every clipping box", () => {
		expect(buttonInSight(at, [], viewport)).toBe(true);
		expect(
			buttonInSight(
				at,
				[{ top: 50, bottom: 400, left: 0, right: 375 }],
				viewport,
			),
		).toBe(true);
	});

	it("is out of sight past any edge of the window", () => {
		expect(buttonInSight(button(40, -40), [], viewport)).toBe(false);
		expect(buttonInSight(button(40, 660), [], viewport)).toBe(false);
		expect(buttonInSight(button(-30, 100), [], viewport)).toBe(false);
		expect(buttonInSight(button(360, 100), [], viewport)).toBe(false);
	});

	it("is out of sight when a box around it cuts off its middle", () => {
		// Scrolled up under the top of a box that scrolls; and under its foot.
		expect(
			buttonInSight(
				at,
				[{ top: 120, bottom: 600, left: 0, right: 375 }],
				viewport,
			),
		).toBe(false);
		expect(
			buttonInSight(
				at,
				[{ top: 0, bottom: 110, left: 0, right: 375 }],
				viewport,
			),
		).toBe(false);
		// Any one box is enough.
		expect(
			buttonInSight(
				at,
				[
					{ top: 0, bottom: 600, left: 0, right: 375 },
					{ top: 0, bottom: 600, left: 60, right: 375 },
				],
				viewport,
			),
		).toBe(false);
	});
});
