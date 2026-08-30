import { describe, expect, it } from "vitest";

/**
 * Every page must offer the language control.
 *
 * It used to live inside Header.vue, and Header.vue is rendered by exactly one
 * view, Mailbox.vue. So sign-in, registration, password reset, the mailbox
 * list, the account page and the admin panel had no way to change language at
 * all -- and sign-in and password reset are precisely where someone who does
 * not read the default language starts. The reset mail is sent in whatever
 * locale that page happened to be showing, which was always the default.
 *
 * The arrangement now: a view with a row of actions of its own renders the
 * switcher in that row and its route says `meta.hasLanguageSwitcher`; App.vue
 * floats one on every route that does not. What breaks is the two halves
 * disagreeing -- a route flagged whose view does not render one leaves that
 * page with no control and no warning, and the reverse shows two.
 *
 * Sources come from import.meta.glob rather than node:fs, for the reason
 * formContrast.test.ts documents: src/ is type-checked without Node types.
 */

const glob = (pattern: Record<string, string>) => pattern;

const views = glob(
	import.meta.glob("../views/*.vue", {
		query: "?raw",
		import: "default",
		eager: true,
	}) as Record<string, string>,
);

const components = glob(
	import.meta.glob("./*.vue", {
		query: "?raw",
		import: "default",
		eager: true,
	}) as Record<string, string>,
);

const routerSource = Object.values(
	import.meta.glob("../router/index.ts", {
		query: "?raw",
		import: "default",
		eager: true,
	}) as Record<string, string>,
)[0];

const appSource = Object.values(
	import.meta.glob("../App.vue", {
		query: "?raw",
		import: "default",
		eager: true,
	}) as Record<string, string>,
)[0];

const basename = (path: string) => path.split("/").pop() ?? path;
const RENDERS_SWITCHER = "<LanguageSwitcher";

/**
 * A view renders the control if it uses the component itself, or if it renders
 * Header, which does. Mailbox.vue is the second case.
 */
function rendersSwitcher(source: string): boolean {
	return source.includes(RENDERS_SWITCHER) || source.includes("<Header");
}

describe("the language switcher is reachable from every page", () => {
	it("is rendered by the header", () => {
		expect(components["./Header.vue"]).toContain(RENDERS_SWITCHER);
	});

	it("is floated by App on routes that do not have their own", () => {
		expect(appSource).toContain(RENDERS_SWITCHER);
		expect(appSource).toContain('v-if="!route.meta.hasLanguageSwitcher"');
	});

	it("flags exactly the routes whose view renders one", () => {
		const viewsWithSwitcher = Object.entries(views)
			.filter(([, source]) => rendersSwitcher(source))
			.map(([path]) => basename(path).replace(/\.vue$/, ""))
			.sort();

		// Each route block names its component on its own line, so the nearest
		// `component:` above the flag is that route's component.
		const lines = routerSource.split("\n");
		const flagged: string[] = [];
		lines.forEach((line, index) => {
			if (!/hasLanguageSwitcher:\s*true/.test(line)) return;
			for (let i = index; i >= 0; i--) {
				const match = lines[i].match(/^\s*component:\s*(\w+),/);
				if (match) {
					flagged.push(match[1]);
					return;
				}
			}
			flagged.push("(no component found)");
		});

		expect(flagged.sort()).toEqual(viewsWithSwitcher);
	});

	it("keeps a single implementation of the select", () => {
		const withSelect = Object.entries({ ...views, ...components })
			.filter(([, source]) => source.includes('<option value="ja">'))
			.map(([path]) => basename(path))
			.sort();

		expect(withSelect).toEqual(["LanguageSwitcher.vue"]);
	});

	it("does not float into the corner Toast occupies", () => {
		// Toast is `fixed top-4 right-4`; a toast would cover a control placed
		// there -- silently, and only while a toast is up. Matched on the class
		// binding rather than anywhere in the file, so naming the clash in a
		// comment does not read as committing it.
		expect(components["./Toast.vue"]).toContain("top-4 right-4");
		const floatingClass = components["./LanguageSwitcher.vue"].match(
			/floating \? '([^']+)'/,
		);
		expect(floatingClass?.[1]).toBeDefined();
		expect(floatingClass?.[1]).not.toContain("right-");
	});
});
