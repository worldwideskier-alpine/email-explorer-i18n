import { describe, expect, it } from "vitest";
import { guardReferrerPolicy } from "./referrerGuard";

/**
 * Chromium applies a `<meta name="referrer">` found by DOMParser to the page
 * that did the parsing (measured; see referrerGuard.ts). jsdom does not, so
 * what is held here is the half that is ours: after any parse, the policy the
 * page's head says last is the page's own.
 */

const lastReferrerMeta = () =>
	Array.from(document.head.querySelectorAll('meta[name="referrer"]')).pop();

describe("the page's referrer policy", () => {
	it("is said again after every parse", () => {
		guardReferrerPolicy();
		document.head.querySelector("meta[data-referrer-guard]")?.remove();

		new DOMParser().parseFromString(
			'<html><head><meta name="referrer" content="unsafe-url"></head><body>x</body></html>',
			"text/html",
		);

		expect(lastReferrerMeta()?.getAttribute("content")).toBe("same-origin");
	});

	it("is said once, not once more for every parse", () => {
		guardReferrerPolicy();
		for (let i = 0; i < 5; i++) {
			new DOMParser().parseFromString("<p>x</p>", "text/html");
		}
		expect(
			document.head.querySelectorAll("meta[data-referrer-guard]"),
		).toHaveLength(1);
	});

	it("still hands back the parsed document", () => {
		guardReferrerPolicy();
		const doc = new DOMParser().parseFromString("<p id=a>x</p>", "text/html");
		expect(doc.getElementById("a")?.textContent).toBe("x");
	});
});

/**
 * Installed before the application exists: the first message parsed is
 * already too late to start.
 */
describe("the application", () => {
	it("guards the policy before it creates the app", () => {
		const source = Object.values(
			import.meta.glob("../main.ts", {
				query: "?raw",
				import: "default",
				eager: true,
			}),
		)[0] as string;
		const guard = source.indexOf("guardReferrerPolicy();");
		expect(guard).toBeGreaterThan(-1);
		expect(guard).toBeLessThan(source.indexOf("createApp(App)"));
	});
});
