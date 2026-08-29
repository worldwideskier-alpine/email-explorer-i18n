import { describe, expect, it } from "vitest";

/**
 * index.html pins the page to a dark palette unconditionally
 * (`<body class="bg-gray-900 text-gray-100">`), while individual cards use the
 * `bg-white dark:bg-gray-800` pattern and follow the viewer's colour scheme.
 *
 * So in light mode a card turns white but text still inherits gray-100 from
 * the body. Anything that doesn't set its own light-mode colour renders
 * near-white on white -- invisible. That is what happened to the admin panel's
 * "new user" form: the address typed into it could not be seen, and the form
 * looked broken rather than merely hard to read.
 *
 * Computed colours can't be checked here (jsdom doesn't run Tailwind), so this
 * asserts the source-level invariant instead: every form control a person
 * types into declares an unprefixed text colour.
 *
 * The sources come from import.meta.glob rather than node:fs. Everything under
 * src/ is type-checked by tsconfig.app.json, which extends @vue/tsconfig's DOM
 * config and so has no Node types; reading files directly only compiled here
 * because a dependency happened to leak @types/node into scope.
 */

const views = import.meta.glob("./*.vue", {
	query: "?raw",
	import: "default",
	eager: true,
}) as Record<string, string>;

const CONTROL = /<(input|select|textarea)\b[^>]*?>/gs;
const CLASS = /class="([^"]*)"/s;
const LIGHT_TEXT_COLOUR =
	/^text-(?:black|white|(?:gray|slate|zinc|neutral|stone|red|green|indigo)-\d{2,3})$/;

interface Control {
	file: string;
	line: number;
	tag: string;
}

function controlsMissingLightColour(): Control[] {
	const missing: Control[] = [];

	for (const [path, source] of Object.entries(views)) {
		for (const match of source.matchAll(CONTROL)) {
			const tag = match[0];
			const classes = (CLASS.exec(tag)?.[1] ?? "").split(/\s+/);

			// A visually hidden control (a styled toggle's real checkbox) renders
			// no text of its own, so its colour is irrelevant.
			if (classes.includes("sr-only")) continue;
			if (classes.some((c) => LIGHT_TEXT_COLOUR.test(c))) continue;

			missing.push({
				file: path.replace("./", ""),
				line: source.slice(0, match.index).split("\n").length,
				tag: match[1],
			});
		}
	}

	return missing;
}

describe("form controls stay readable in light mode", () => {
	it("every control a person types into sets its own text colour", () => {
		const missing = controlsMissingLightColour().map(
			({ file, line, tag }) => `${file}:${line} <${tag}>`,
		);

		expect(missing).toEqual([]);
	});

	// Guards the check itself: without it, the assertion above could pass
	// because the scan found nothing rather than because the views are correct.
	it("actually inspects the views", () => {
		expect(Object.keys(views)).toContain("./Admin.vue");

		const controls = views["./Admin.vue"].match(CONTROL);
		expect(controls?.length).toBeGreaterThan(3);
	});
});
