import { describe, expect, it } from "vitest";
import {
	looksLikeANewBuild,
	moduleScriptsIn,
	moduleScriptsOf,
	somethingIsBeingWritten,
} from "./appUpdate";

/**
 * A deployed fix that never reaches the screen is not a fix.
 *
 * What happened, and what this is here to stop happening again: a link fault
 * was repaired, the deployment was verified against production byte for byte,
 * and the phone that reported it saw no change whatever. The application was
 * on a home screen, and a page opened that way is resumed rather than loaded
 * -- so it went on running the build it had started with, and nothing in the
 * application could tell.
 *
 * The rules below are the whole of the judgement: what counts as a different
 * build, what counts as not knowing, and when a reload would cost somebody
 * something.
 */

const PAGE = `<!doctype html><html><head>
	<script type="module" crossorigin src="/assets/index-AAA111.js"></script>
	<link rel="stylesheet" href="/assets/index-BBB222.css">
	<link rel="modulepreload" href="/assets/shared-CCC333.js">
	<script src="/some-analytics.js"></script>
	</head><body><div id="app"></div></body></html>`;

/** A page as the running document has it: preloads the server never sent. */
function runningDocument(): Document {
	const doc = document.implementation.createHTMLDocument("app");
	const script = doc.createElement("script");
	script.type = "module";
	script.setAttribute("src", "/assets/index-AAA111.js");
	doc.head.appendChild(script);
	// What a dynamic import leaves behind. The catalogue for whichever
	// language was chosen is loaded this way, and the served file says
	// nothing about it.
	const preload = doc.createElement("link");
	preload.rel = "modulepreload";
	preload.href = "/assets/ja-DDD444.js";
	doc.head.appendChild(preload);
	return doc;
}

describe("which build a page is", () => {
	/**
	 * Only `<script type="module">`, and the fixture carries the two things
	 * that must not be counted: a preload, and an ordinary script. Both would
	 * otherwise make two pages of the same build look different.
	 */
	it("is the module scripts it names, and nothing else on the page", () => {
		expect(moduleScriptsIn(PAGE)).toEqual(["/assets/index-AAA111.js"]);
	});

	it("reads the same way from a live document", () => {
		expect(moduleScriptsOf(runningDocument())).toEqual([
			"/assets/index-AAA111.js",
		]);
	});

	/**
	 * The two sides have to agree, which is the whole point: the running
	 * document has collected preloads that the served file has never heard
	 * of, and if either side counted them the app would decide it was out of
	 * date every time somebody changed language -- and reload, and decide it
	 * again.
	 */
	it("says the served page and the running one are the same build", () => {
		expect(
			looksLikeANewBuild(
				moduleScriptsOf(runningDocument()),
				moduleScriptsIn(PAGE),
			),
		).toBe(false);
	});
});

describe("whether to reload", () => {
	it("reloads when the name has changed, which means the bytes have", () => {
		expect(
			looksLikeANewBuild(
				["/assets/index-AAA111.js"],
				["/assets/index-ZZZ999.js"],
			),
		).toBe(true);
	});

	it("does nothing when it is the same build", () => {
		expect(
			looksLikeANewBuild(
				["/assets/index-AAA111.js"],
				["/assets/index-AAA111.js"],
			),
		).toBe(false);
	});

	/**
	 * The dangerous direction. A captive portal, an error page, a dev server
	 * with no built assets: none of those mean "out of date", and reading them
	 * that way would put the app in a reload loop against a page that never
	 * satisfies it.
	 */
	it("treats not knowing as no", () => {
		expect(looksLikeANewBuild([], ["/assets/index-AAA111.js"])).toBe(false);
		expect(looksLikeANewBuild(["/assets/index-AAA111.js"], [])).toBe(false);
		expect(looksLikeANewBuild([], [])).toBe(false);
		expect(moduleScriptsIn("<html><body>login required</body></html>")).toEqual(
			[],
		);
	});
});

describe("what a reload would cost", () => {
	const page = () => {
		document.body.innerHTML = "";
		return document.body;
	};

	it("waits while a message is being written", () => {
		const body = page();
		body.innerHTML = '<div contenteditable="true">お世話になっております</div>';
		expect(somethingIsBeingWritten(document)).toBe(true);
	});

	it("waits while there is text in a box, focused or not", () => {
		const body = page();
		const area = document.createElement("textarea");
		area.value = "half a reply";
		body.appendChild(area);
		expect(somethingIsBeingWritten(document)).toBe(true);
	});

	it("waits while the cursor is in a field, even an empty one", () => {
		const body = page();
		const input = document.createElement("input");
		body.appendChild(input);
		input.focus();
		expect(somethingIsBeingWritten(document)).toBe(true);
	});

	it("goes ahead when nothing is being written", () => {
		const body = page();
		body.innerHTML =
			'<div contenteditable="true">   </div><textarea></textarea><p>読むだけ</p>';
		(document.activeElement as HTMLElement | null)?.blur?.();
		expect(somethingIsBeingWritten(document)).toBe(false);
	});
});
