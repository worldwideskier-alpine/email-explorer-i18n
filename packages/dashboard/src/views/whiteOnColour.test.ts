import { describe, expect, it } from "vitest";

/**
 * White text needs a background dark enough to read it against.
 *
 * Tailwind 4 rebased its palette into oklch, and the new colours are lighter
 * than the hex-era ones the buttons in here were written against. `green-600`
 * is the one that fell through: white on it measures 3.22:1 where 4.5 is
 * wanted, in both themes, which is the "新規メールボックス" button on the
 * mailbox list -- the first button somebody sees after signing in. Nothing
 * said so, because it is not a light/dark bug and looks perfectly deliberate.
 *
 * The ratios below were measured in Chromium against this project's own built
 * stylesheet -- a div painted with each colour, the pixel read back, the
 * contrast computed from that -- and not taken from a table of Tailwind's
 * hexes, which is what made the button wrong in the first place. Every colour
 * white sits on has to be in this list: a colour that is not has not been
 * measured, and "it looks fine" is what this test exists to stop.
 *
 * What it does not cover: dark text on a light background (a different table),
 * hover and focus states, disabled controls (excluded by WCAG), and text over
 * an image. The screen-by-screen measurement that found this one covers those
 * in a browser; this holds the part that can be held from the source.
 */

const sources = {
	...(import.meta.glob("./*.vue", {
		query: "?raw",
		import: "default",
		eager: true,
	}) as Record<string, string>),
	...(import.meta.glob("../components/*.vue", {
		query: "?raw",
		import: "default",
		eager: true,
	}) as Record<string, string>),
};

/** Contrast against white, measured in a browser. See the note above. */
const MEASURED: Record<string, number> = {
	"green-600": 3.22,
	"green-700": 4.95,
	"green-800": 7.13,
	"red-600": 4.77,
	"red-700": 6.42,
	"indigo-600": 6.46,
	"indigo-700": 8.09,
	"gray-700": 10.3,
	"gray-800": 14.67,
	"gray-900": 17.75,
};

const WANTED = 4.5;

interface Pair {
	file: string;
	colour: string;
	line: number;
}

/**
 * Every place white text is put on a named background.
 *
 * Read per class attribute, and per half of the theme: `text-white` with a
 * `dark:bg-…` only applies in dark mode if no `dark:text-…` takes the text
 * somewhere else, which is how the one button that flips both is written.
 */
function whiteOnColour(): Pair[] {
	const found: Pair[] = [];
	for (const [path, source] of Object.entries(sources)) {
		for (const match of source.matchAll(/class="([^"]*)"/gs)) {
			const classes = match[1].split(/\s+/);
			const line = source.slice(0, match.index).split("\n").length;
			const file = path.replace(/^\.\.?\//, "");

			const bg = (prefix: string) =>
				classes
					.filter((c) => c.startsWith(`${prefix}bg-`))
					.map((c) => c.slice(`${prefix}bg-`.length))
					.filter((c) => /^[a-z]+-\d{2,3}$/.test(c));

			if (classes.includes("text-white")) {
				for (const colour of bg("")) found.push({ file, colour, line });
				// Same element in dark mode, unless the text changes there too.
				if (!classes.some((c) => c.startsWith("dark:text-"))) {
					for (const colour of bg("dark:")) found.push({ file, colour, line });
				}
			}
			if (classes.includes("dark:text-white")) {
				for (const colour of bg("dark:")) found.push({ file, colour, line });
			}
		}
	}
	return found;
}

describe("white text on a coloured background", () => {
	const pairs = whiteOnColour();

	it("is used somewhere, so this test is looking at something", () => {
		expect(pairs.length).toBeGreaterThan(5);
	});

	it("only sits on colours that have been measured", () => {
		const unmeasured = pairs.filter((p) => MEASURED[p.colour] === undefined);
		expect(
			unmeasured.map((p) => `${p.file}:${p.line} bg-${p.colour}`),
			"measure the colour in a browser and add it to MEASURED",
		).toEqual([]);
	});

	it("only sits on colours dark enough to read it", () => {
		const failing = pairs
			.filter((p) => (MEASURED[p.colour] ?? 0) < WANTED)
			.map(
				(p) => `${p.file}:${p.line} bg-${p.colour} (${MEASURED[p.colour]}:1)`,
			);
		expect(failing).toEqual([]);
	});
});
