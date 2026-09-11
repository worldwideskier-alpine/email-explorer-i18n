import { describe, expect, it } from "vitest";

/**
 * WCAG 2.2 SC 1.4.10 (Reflow): at 320 CSS pixels wide, the page must not ask
 * the reader to scroll in two directions, and nothing may be lost.
 *
 * 320px is the criterion's own figure -- a 1280px page at 400% zoom -- and it
 * is also a real phone held in one hand. Measured in Chromium over thirteen
 * screens, signed out, signed in, with the drawer open, with the compose
 * dialog up, and as the privileged account, in both colour schemes.
 *
 * What was found, before any of this:
 *
 *   every signed-in screen   the page scrolled sideways by 16px
 *   /account, /admin         by 52px
 *   /root                    by 9px
 *   the email card           4px of it cut off by a box that hides overflow
 *   the header's search box  0 pixels wide -- and this one nothing reported
 *
 * The last is the one worth naming. The row fitted, so no audit complained:
 * the menu button, the two links and the language control were each the size
 * they are, the search field was the only thing that could give, and it gave
 * everything. The input still painted 66px of itself out of its collapsed
 * wrapper, under the links -- a stub you could not read what you typed in,
 * over which a click landed on "mailboxes". Functionality lost, with the page
 * measuring clean. A second pass measures every control's rendered box for
 * exactly that reason.
 *
 * The header wraps below sm now, and the search box takes the second line.
 * What that buys, measured (the width of the search input):
 *
 *   320px   66px covered by the links  ->  288px on its own line
 *   375px   63px                       ->  343px
 *   640px   208px                      ->  208px, one line, unchanged
 *   1280px  446px                      ->  446px, one line, unchanged
 *
 * Negative control: reverting only the two-line header put the field back to
 * 66px under the links; reverting the whole change set brought all eleven
 * findings back. Both measured against a rebuilt bundle whose hash was
 * checked against the one the server was actually serving -- building the
 * dashboard alone does not change what `wrangler dev` serves, which made an
 * earlier negative control say "0 findings" while proving nothing.
 *
 * This file holds what can be held from the source: the handful of places
 * where something was told it may shrink. The measurement itself lives in the
 * record above.
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

const source = (name: string): string => {
	const text = sources[name];
	expect(text, `${name} is not where this test expects it`).toBeDefined();
	return text;
};

/** The class attribute of the first element whose classes contain `marker`. */
const classesContaining = (text: string, marker: string): string => {
	const found = [...text.matchAll(/class="([^"]*)"/g)]
		.map((match) => match[1])
		.filter((classes) => classes.includes(marker));
	expect(found, `no element with \`${marker}\``).not.toHaveLength(0);
	return found[0];
};

describe("the header keeps everything it has at 320px", () => {
	const header = source("../components/Header.vue");

	it("is allowed to take a second line", () => {
		const tag = /<header class="([^"]*)"/.exec(header)?.[1];
		expect(tag).toBeDefined();
		expect(tag).toContain("flex-wrap");
	});

	it("gives the search box that second line, and only below sm", () => {
		const search = classesContaining(header, "relative order-last");
		// Last in the row and the full width of it: the wrap lands here.
		expect(search).toContain("w-full");
		expect(search).toContain("min-w-0");
		// And back beside the rest from sm up, where the room is there.
		expect(search).toContain("sm:order-none");
		expect(search).toContain("sm:w-auto");
		expect(search).toContain("sm:flex-1");
	});

	it("lets the group at the end shrink", () => {
		const group = classesContaining(header, "ms-auto");
		expect(group).toContain("min-w-0");
		// This is what pushed the header past the viewport at 320px.
		expect(group).not.toContain("flex-shrink-0");
	});

	it("lets the language control shrink below its cap", () => {
		const switcher = source("../components/LanguageSwitcher.vue");
		const select = classesContaining(switcher, "max-w-[11rem]");
		expect(select).toContain("w-full");
		expect(select).toContain("min-w-0");
		// A flex item will not go under its content width without being told.
		expect(switcher).toContain("min-w-0'");
	});
});

describe("a row of actions beside a heading", () => {
	// /account and /admin were the worst of them, 52px of sideways scrolling:
	// two buttons and the language control, none of which would give.
	it.each(["./Account.vue", "./Admin.vue"])("shrinks instead (%s)", (name) => {
		const row = classesContaining(
			source(name),
			"flex items-center gap-2 min-w",
		);
		expect(row).toContain("min-w-0");
		expect(row).not.toContain("flex-shrink-0");
	});
});

describe("a form field wider than the screen", () => {
	it("stacks rather than pushing the page sideways", () => {
		const root = source("./Root.vue");
		// The three fields of the create-an-account form, each `w-72` inside a
		// wrapper that was content-width: the wrapper is the full line below sm
		// and the field's own `max-w-full` then applies to something.
		const wrappers = [...root.matchAll(/class="w-full sm:w-auto"/g)];
		expect(wrappers).toHaveLength(3);
		expect(classesContaining(root, "mt-1 w-72")).toContain("max-w-full");
		expect(classesContaining(root, "mt-1 w-72")).toContain("min-w-0");
	});

	it("does not let a file picker set the page's width", () => {
		// `<input type=file>` is as wide as the button plus the file name the
		// browser writes beside it, and that is not a width anyone chose.
		const restore = classesContaining(source("./Settings.vue"), "file:me-3");
		expect(restore).toContain("w-full");
		expect(restore).toContain("min-w-0");
	});
});
