import { describe, expect, it } from "vitest";

/**
 * Everything that can be clicked shows the same cursor.
 *
 * The browser's own stylesheet gives `cursor: pointer` to `<a href>` and to
 * nothing else; `<button>` and `<select>` keep the arrow. Tailwind v3's
 * Preflight filled that in with `button, [role="button"] { cursor: pointer }`
 * and v4 removed it, so the header row ended up split by element type rather
 * than by behaviour: "Account" and "Admin panel" are router-links and showed a
 * hand, while "Log out" and "New mailbox" are buttons and the language control
 * is a select, and all three showed an arrow. Nothing about those five is
 * different to the person clicking them.
 *
 * jsdom does not run Tailwind, so the computed cursor cannot be read here (the
 * real-browser check covers that). What is checked instead is the selector
 * itself, against real elements: that it reaches buttons, selects and
 * `role="button"`, and that it stops at disabled ones -- a disabled submit
 * button carries `disabled:cursor-not-allowed`, and this must not be written so
 * as to fight it.
 *
 * The source comes from import.meta.glob rather than node:fs, for the reason
 * formContrast.test.ts documents: src/ is type-checked without Node types.
 */

const mainCss = Object.values(
	import.meta.glob("./main.css", {
		query: "?raw",
		import: "default",
		eager: true,
	}) as Record<string, string>,
)[0];

/** The selector list of every `{ cursor: pointer }` rule in the sheet. */
const POINTER_RULES = /([^{}]+)\{\s*cursor:\s*pointer;?\s*\}/g;

/** Comments are stripped first: this file explains the v3 rule by quoting it. */
const withoutComments = mainCss.replace(/\/\*[\s\S]*?\*\//g, "");

function pointerSelectors(css: string): { selector: string; at: number }[] {
	return [...css.matchAll(POINTER_RULES)].map((match) => ({
		selector: match[1].trim().replace(/\s+/g, " "),
		at: match.index,
	}));
}

function matches(selector: string, html: string): boolean {
	const host = document.createElement("div");
	host.innerHTML = html;
	const element = host.firstElementChild;
	if (!element) throw new Error(`no element in ${html}`);
	return element.matches(selector);
}

describe("the cursor says what is clickable", () => {
	const rules = pointerSelectors(withoutComments);
	const selector = rules[0]?.selector ?? "";

	it("declares one rule for it, in the base layer", () => {
		expect(rules).toHaveLength(1);

		// In `base`, so that a utility class on any single element still wins.
		// Tailwind emits `@layer theme, base, components, utilities` ahead of
		// everything, and later layers beat earlier ones whatever the
		// specificity.
		const layer = withoutComments.indexOf("@layer base");
		expect(layer).toBeGreaterThanOrEqual(0);
		expect(rules[0].at).toBeGreaterThan(layer);
	});

	it("reaches every kind of control that is clicked but is not a link", () => {
		expect(matches(selector, "<button>Log out</button>")).toBe(true);
		expect(matches(selector, '<button type="submit">Send</button>')).toBe(true);
		expect(matches(selector, "<select><option>ja</option></select>")).toBe(
			true,
		);
		expect(matches(selector, '<div role="button">Open</div>')).toBe(true);
	});

	it("leaves a disabled control alone, so `disabled:cursor-not-allowed` holds", () => {
		expect(matches(selector, "<button disabled>Sending…</button>")).toBe(false);
		expect(matches(selector, "<select disabled></select>")).toBe(false);
	});

	// Anchors already get it from the browser, and claiming them here would
	// quietly take over a rule that is not ours to hold.
	it("does not restate what the browser already does for links", () => {
		expect(matches(selector, '<a href="/account">Account</a>')).toBe(false);
	});
});
