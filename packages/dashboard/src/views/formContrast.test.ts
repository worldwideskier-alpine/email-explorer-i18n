import { describe, expect, it } from "vitest";

/**
 * index.html used to pin the page to a dark palette unconditionally
 * (`<body class="bg-gray-900 text-gray-100">`), while individual cards used
 * the `bg-white dark:bg-gray-800` pattern and followed the viewer's colour
 * scheme.
 *
 * So in light mode a card turned white but text still inherited gray-100 from
 * the body. Anything that didn't set its own light-mode colour rendered
 * near-white on white -- invisible. That is what happened to the admin panel's
 * "new user" form: the address typed into it could not be seen, and the form
 * looked broken rather than merely hard to read.
 *
 * The body carries both halves now, so the inheritance is no longer the
 * hazard it was. This stays because the rule it holds is still the right one:
 * a control somebody types into should say what colour that text is rather
 * than inherit it from whatever encloses it this month. What the body does is
 * not this file's to depend on.
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
	// The admin screen is smaller than it was -- the role column, the access
	// modal and the promote buttons are gone -- so the floor is what it now
	// actually has: the key field and the two fields for adding a login.
	it("actually inspects the views", () => {
		expect(Object.keys(views)).toContain("./Admin.vue");

		const controls = views["./Admin.vue"].match(CONTROL);
		expect(controls?.length).toBeGreaterThanOrEqual(3);
	});
});
