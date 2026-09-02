import { describe, expect, it } from "vitest";
import { stripRemoteContent } from "./remoteContent";

/**
 * Everything here is asked of the *string*, not of a rendered frame.
 *
 * That is the property under test. A body that reaches the parser with an
 * address still in it has already been fetched by the time any later pass
 * could remove it, so "the markup carries no address" is the only form of the
 * question whose answer arrives in time.
 */

/** What a browser would go and get, spelled every way this has to survive. */
const fetchesSomething = (html: string) =>
	/https?:\/\/|\/\/tracker|cid:/i.test(html);

describe("what a spam message is allowed to load", () => {
	it("takes the address off an image", () => {
		const out = stripRemoteContent(
			'<p>hello</p><img src="https://tracker.example/pixel.gif" alt="">',
		);
		expect(fetchesSomething(out)).toBe(false);
		expect(out).toContain("hello");
	});

	/**
	 * The pixel that started this: one by one, transparent, styled out of the
	 * way, and it is the entire reason the message was sent to an address
	 * nobody has confirmed is real.
	 */
	it("takes it off an image nobody can see either", () => {
		expect(
			stripRemoteContent(
				'<img src="https://tracker.example/o.gif?id=deadbeef" width="1" height="1" style="display:none">',
			),
		).not.toContain("tracker.example");
	});

	it("leaves the element behind so its alt text still says what was there", () => {
		const out = stripRemoteContent(
			'<img src="https://tracker.example/logo.png" alt="SAISON">',
		);
		expect(out).toContain("<img");
		expect(out).toContain("SAISON");
	});

	it("takes every candidate out of a srcset, not just the first", () => {
		const out = stripRemoteContent(
			'<img src="https://a.example/1.png" srcset="https://b.example/2.png 2x, https://c.example/3.png 3x">',
		);
		expect(fetchesSomething(out)).toBe(false);
	});

	// Older than CSS, still honoured, and still a request.
	it("knows the attributes that predate CSS", () => {
		const out = stripRemoteContent(
			'<table background="https://tracker.example/bg.png"><tr><td><img lowsrc="https://tracker.example/low.gif"></td></tr></table>',
		);
		expect(fetchesSomething(out)).toBe(false);
	});

	it("silences the things that play by themselves", () => {
		const out = stripRemoteContent(
			'<video poster="https://tracker.example/p.jpg" src="https://tracker.example/v.mp4"></video>' +
				'<audio><source src="https://tracker.example/a.mp3"></audio>' +
				'<object data="https://tracker.example/o.swf"></object>',
		);
		expect(fetchesSomething(out)).toBe(false);
	});

	it("drops a stylesheet link, which is a fetch with nothing to show", () => {
		const out = stripRemoteContent(
			'<link rel="stylesheet" href="https://tracker.example/mail.css"><p>hi</p>',
		);
		expect(fetchesSomething(out)).toBe(false);
		expect(out.toLowerCase()).not.toContain("<link");
	});

	/**
	 * No click needed and no image needed: the frame navigates itself to the
	 * sender's address a moment after it opens, which reports the open exactly
	 * as well as a pixel does.
	 */
	it("drops a meta refresh", () => {
		const out = stripRemoteContent(
			'<meta http-equiv="refresh" content="0;url=https://tracker.example/opened"><p>hi</p>',
		);
		expect(fetchesSomething(out)).toBe(false);
		expect(out).toContain("hi");
	});

	it("keeps SVG from fetching through either spelling of href", () => {
		const out = stripRemoteContent(
			'<svg><image href="https://tracker.example/a.png"></image>' +
				'<image xlink:href="https://tracker.example/b.png"></image>' +
				'<use href="https://tracker.example/s.svg#i"></use></svg>',
		);
		expect(fetchesSomething(out)).toBe(false);
	});

	it("does not spare an inline attachment either", () => {
		expect(
			stripRemoteContent('<img src="cid:logo@example" alt="logo">'),
		).not.toContain("cid:");
	});
});

describe("the CSS a spam message carries", () => {
	it("turns a background image into no background image", () => {
		const out = stripRemoteContent(
			'<div style="background-image: url(https://tracker.example/bg.png); color: red">x</div>',
		);
		expect(fetchesSomething(out)).toBe(false);
		// The declaration is still a declaration. Deleting the value would
		// leave `background-image: ;`, which a browser drops as malformed --
		// the same result, arrived at by pretending nothing was there.
		expect(out).toContain("none");
		expect(out).toContain("color: red");
	});

	it("does not care how the address is quoted", () => {
		for (const value of [
			"url(https://tracker.example/a.png)",
			`url("https://tracker.example/a.png")`,
			"url( 'https://tracker.example/a.png' )",
		]) {
			expect(
				fetchesSomething(
					stripRemoteContent(`<div style="background: ${value}">x</div>`),
				),
			).toBe(false);
		}
	});

	it("reaches inside a style block, where mail puts most of its styling", () => {
		const out = stripRemoteContent(
			"<style>.hero { background: url(https://tracker.example/hero.png) no-repeat; }</style><div class='hero'>x</div>",
		);
		expect(fetchesSomething(out)).toBe(false);
		expect(out).toContain(".hero");
	});

	/**
	 * `@import` fetches a stylesheet with no `url()` around the address, so the
	 * pass that rewrites addresses never sees it.
	 */
	it("drops an @import, address and all", () => {
		const out = stripRemoteContent(
			`<style>@import "https://tracker.example/mail.css"; p { margin: 0 }</style><p>x</p>`,
		);
		expect(fetchesSomething(out)).toBe(false);
		expect(out).toContain("margin: 0");
	});

	/**
	 * The HTML parser puts a leading `<style>` in `<head>`, and Outlook opens
	 * every message it sends with one. Returning only the body would throw the
	 * message's entire stylesheet away and leave it looking broken -- a
	 * silent second cost for asking not to be tracked.
	 */
	it("keeps a stylesheet the parser moved into the head", () => {
		const out = stripRemoteContent(
			"<style>p { margin-top: 0 }</style><p>hello</p>",
		);
		expect(out).toContain("margin-top: 0");
		expect(out).toContain("hello");
		expect(out.indexOf("margin-top")).toBeLessThan(out.indexOf("hello"));
	});
});

describe("what is left alone", () => {
	// Links are a separate question with a separate answer: they are made
	// inert on load so a click cannot follow them. Nothing about a link fetches
	// anything until it is clicked, so there is no reason to lose the address
	// a reader may want to look at.
	it("leaves an anchor's destination readable", () => {
		expect(
			stripRemoteContent('<a href="https://phish.example/login">sign in</a>'),
		).toContain("https://phish.example/login");
	});

	it("leaves the words of the message exactly as they were", () => {
		const out = stripRemoteContent(
			"<p>ご請求金額のお知らせ</p><blockquote>元のメール</blockquote>",
		);
		expect(out).toContain("ご請求金額のお知らせ");
		expect(out).toContain("<blockquote>元のメール</blockquote>");
	});

	it("copes with an empty body", () => {
		expect(stripRemoteContent("")).toBe("");
	});
});

/**
 * These are here because this function is the only thing standing between a
 * spam message and its sender's server. A frame policy would have caught what
 * a rewrite is worst at, and a `<meta http-equiv="Content-Security-Policy">`
 * in a `srcdoc` document turns out not to be enforced at all -- written,
 * measured, and removed rather than left looking like protection. So the
 * spellings a regular expression is likeliest to miss get their own cases.
 */
describe("the spellings a rewrite is worst at", () => {
	it("catches an image-set that names its addresses as bare strings", () => {
		const out = stripRemoteContent(
			`<div style='background-image: image-set("https://tracker.example/a.png" 1x, "https://tracker.example/b.png" 2x)'>x</div>`,
		);
		expect(fetchesSomething(out)).toBe(false);
	});

	it("catches one wrapped around url(), without leaving the wrapper behind", () => {
		const out = stripRemoteContent(
			'<div style="background-image: -webkit-image-set(url(https://tracker.example/a.png) 1x)">x</div>',
		);
		expect(fetchesSomething(out)).toBe(false);
		expect(out).not.toContain("image-set");
	});

	it("catches an @import that puts its address inside url()", () => {
		const out = stripRemoteContent(
			"<style>@import url(https://tracker.example/mail.css); p{margin:0}</style>",
		);
		expect(fetchesSomething(out)).toBe(false);
		expect(out).not.toContain("@import");
	});
});
