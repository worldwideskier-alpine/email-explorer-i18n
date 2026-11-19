import { describe, expect, it } from "vitest";
import { placeFromButton } from "./popupPlacement";

const window = { width: 375, height: 667 };
const panel = { width: 154, height: 98 };
const button = (left: number, top: number) => ({
	left,
	right: left + 32,
	top,
	bottom: top + 32,
});

describe("a panel opened from a button", () => {
	it("goes below the button, lined up with its start", () => {
		expect(placeFromButton(button(40, 100), panel, window, false)).toEqual({
			top: 136,
			left: 40,
		});
	});

	it("lines up with the button's right edge when the page reads right to left", () => {
		expect(placeFromButton(button(200, 100), panel, window, true)).toEqual({
			top: 136,
			left: 232 - 154,
		});
	});

	it("goes above the button when there is no room below and room above", () => {
		expect(placeFromButton(button(40, 600), panel, window, false)).toEqual({
			top: 600 - 4 - 98,
			left: 40,
		});
	});

	it("stays inside the window when the button is near its end", () => {
		// The measured case: a toggle near the end of a phone's toolbar put the
		// panel 68-104px past the editor's edge.
		const { left } = placeFromButton(button(330, 100), panel, window, false);
		expect(left).toBe(375 - 8 - 154);
		expect(placeFromButton(button(0, 100), panel, window, true).left).toBe(8);
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
				window,
				false,
			),
		).toEqual({ top: 8, left: 8 });
	});
});
