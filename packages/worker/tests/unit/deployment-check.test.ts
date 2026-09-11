import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain JS on purpose: this module also runs under node
// from the deploy workflow, where there is nothing to compile it.
import {
	answeredByTheWorker,
	assetMismatch,
	assetsReferencedBy,
	builtAssets,
} from "../../scripts/deployment-check.mjs";

/**
 * Asking the live deployment what it is serving.
 *
 * The deploy step exiting 0 means the upload was accepted, not that the
 * upload is what answers requests. Locally that gap has already produced a
 * verification run that measured a bundle nobody was serving and agreed with
 * whatever was expected of it; the workflow now compares the built entry
 * script's name and bytes against what production hands back.
 *
 * The requests themselves cannot be tested from here -- there is no
 * deployment in the test pool -- so what is held is the reasoning: which file
 * is the build, whether a page is on it, and whether an answer came from the
 * Worker or from the page being served in its place.
 */

/** The shape of the real built index.html, entry tags and all. */
const PAGE = `<!DOCTYPE html>
<html lang="">
  <head>
    <meta charset="UTF-8">
    <link rel="icon" href="/favicon.svg" type="image/svg+xml">
    <title>Email Explorer</title>
    <script type="module" crossorigin src="/assets/index-C9t9Pt6p.js"></script>
    <link rel="stylesheet" crossorigin href="/assets/index-D-tSnx3s.css">
  </head>
  <body><div id="app"></div></body>
</html>`;

/** What the assets directory really looks like: 75 files, two of them entries. */
const LISTING = [
	"ar-CjxRGb0G.js",
	"be-5rVYOA1O.js",
	"index-C9t9Pt6p.js",
	"index-D-tSnx3s.css",
	"ja-BqR1x9Zz.js",
];

describe("which file is the build", () => {
	it("finds the entry script and stylesheet among the locale chunks", () => {
		expect(builtAssets(LISTING)).toEqual({
			js: "index-C9t9Pt6p.js",
			css: "index-D-tSnx3s.css",
		});
	});

	/**
	 * Two generations in one directory is the case worth refusing. Picking
	 * either would make the comparison downstream a coin toss, and a check
	 * that passes half the time by accident is worse than no check.
	 */
	it("refuses a listing it cannot read one build out of", () => {
		expect(() => builtAssets([...LISTING, "index-Deadbeef.js"])).toThrow(
			/found 2/,
		);
		expect(() => builtAssets(["ja-BqR1x9Zz.js"])).toThrow(/found 0/);
	});
});

describe("whether the page is on that build", () => {
	it("reads both entry names out of the page", () => {
		expect(assetsReferencedBy(PAGE)).toEqual([
			"index-C9t9Pt6p.js",
			"index-D-tSnx3s.css",
		]);
	});

	it("says nothing when the page loads the build", () => {
		expect(
			assetMismatch(
				{ js: "index-C9t9Pt6p.js", css: "index-D-tSnx3s.css" },
				PAGE,
			),
		).toBeNull();
	});

	it("names what is being served instead", () => {
		const message = assetMismatch(
			{ js: "index-NewBuild1.js", css: "index-NewBuild2.css" },
			PAGE,
		);
		expect(message).toContain("index-C9t9Pt6p.js");
		expect(message).toContain("index-NewBuild1.js");
	});

	it("does not mistake an error page for a stale one", () => {
		const message = assetMismatch(
			{ js: "index-C9t9Pt6p.js", css: "index-D-tSnx3s.css" },
			"<html><body>error 1016</body></html>",
		);
		expect(message).toContain("no built asset at all");
	});
});

describe("whether an answer came from the Worker", () => {
	/**
	 * The one that matters: the asset handler answers anything it has no file
	 * for with index.html, so a broken API route comes back 200 text/html and
	 * looks perfectly healthy to anything that only checks the status.
	 */
	it("is not fooled by the page being served in the Worker's place", () => {
		expect(answeredByTheWorker(200, "text/html; charset=utf-8")).toBe(false);
	});

	it("counts a refusal, because a refusal is the Worker speaking", () => {
		// An unauthenticated request to an API path is supposed to be turned
		// away. Pinning 200 here would fail every run.
		expect(answeredByTheWorker(401, "application/json")).toBe(true);
		expect(answeredByTheWorker(200, "application/json; charset=utf-8")).toBe(
			true,
		);
	});

	it("does not count the Worker falling over", () => {
		expect(answeredByTheWorker(500, "application/json")).toBe(false);
		expect(answeredByTheWorker(200, null)).toBe(false);
	});
});
