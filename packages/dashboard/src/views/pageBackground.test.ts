import { describe, expect, it } from "vitest";

/**
 * One place decides the page background, and it follows the viewer.
 *
 * Views used to each pick their own, three different ways: a hard-coded light
 * background (`bg-gray-50`), nothing at all (so the body's hard-coded dark one
 * showed through), or a light/dark pair. The same viewer, with one unchanged
 * OS setting, got light on sign-in, dark on the mailbox list and light again
 * in the inbox.
 *
 * The rule now is that index.html carries the only page background and it has
 * both halves; a full-height view adds none of its own. A view that reaches
 * for one again would go back to deciding the theme for its own page.
 *
 * Sources come from import.meta.glob rather than node:fs, for the reason
 * formContrast.test.ts documents: src/ is type-checked without Node types.
 */

const views = import.meta.glob("./*.vue", {
	query: "?raw",
	import: "default",
	eager: true,
}) as Record<string, string>;

const indexHtml = Object.values(
	import.meta.glob("../../index.html", {
		query: "?raw",
		import: "default",
		eager: true,
	}) as Record<string, string>,
)[0];

/** A container sized to the whole page, i.e. one whose background is the page's. */
const FULL_HEIGHT =
	/class="[^"]*\b(?:min-h-screen|h-screen|container mx-auto)\b[^"]*"/g;

describe("the page background is decided in one place", () => {
	it("index.html sets both halves on the body", () => {
		const body = /<body class="([^"]*)"/.exec(indexHtml)?.[1];
		expect(body).toBeDefined();
		// A light background and colour, and a dark counterpart for each.
		expect(body).toMatch(/\bbg-gray-\d{2,3}\b/);
		expect(body).toMatch(/\bdark:bg-gray-\d{2,3}\b/);
		expect(body).toMatch(/\btext-gray-\d{2,3}\b/);
		expect(body).toMatch(/\bdark:text-gray-\d{2,3}\b/);
	});

	it("no full-height view sets a background of its own", () => {
		const offenders: string[] = [];

		for (const [path, source] of Object.entries(views)) {
			for (const match of source.matchAll(FULL_HEIGHT)) {
				if (!/\bbg-/.test(match[0])) continue;
				offenders.push(
					`${path.replace("./", "")}:${
						source.slice(0, match.index).split("\n").length
					} ${match[0].slice(0, 80)}`,
				);
			}
		}

		expect(offenders).toEqual([]);
	});
});
