import { describe, expect, it } from "vitest";
import { prepareFrame } from "./messageFrame";
import { decodeCssEscapes } from "./remoteContent";

/**
 * Everything here is asked of the *string*, not of a rendered frame.
 *
 * That is the property under test. A body that reaches the parser with an
 * address still in it has already been fetched by the time any later pass
 * could remove it, so "the markup carries no address" is the only form of the
 * question whose answer arrives in time.
 *
 * Asked through prepareFrame, which is how the spam folder reaches these
 * rules, and of the frame's own reading of what it returns. These tests used
 * to call a string version of the pass that nothing in production used any
 * more -- it parsed separately and returned head and body, so they passed
 * against a path the frame never took.
 */

/** A spam message, as the frame will read it. */
function spamDocument(html: string): Document {
	return new DOMParser().parseFromString(
		prepareFrame(html, { blockRemoteContent: true }),
		"text/html",
	);
}

/** Its body, serialised -- which writes U+00A0 as `&nbsp;`. */
function spamBody(html: string): string {
	return spamDocument(html).body.innerHTML;
}

/** What a browser would go and get, spelled every way this has to survive. */
const fetchesSomething = (html: string) =>
	/https?:\/\/|\/\/tracker|cid:/i.test(html);

describe("what a spam message is allowed to load", () => {
	it("takes the address off an image", () => {
		const out = spamBody(
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
			spamBody(
				'<img src="https://tracker.example/o.gif?id=deadbeef" width="1" height="1" style="display:none">',
			),
		).not.toContain("tracker.example");
	});

	it("leaves the element behind so its alt text still says what was there", () => {
		const out = spamBody(
			'<img src="https://tracker.example/logo.png" alt="SAISON">',
		);
		expect(out).toContain("<img");
		expect(out).toContain("SAISON");
	});

	it("takes every candidate out of a srcset, not just the first", () => {
		const out = spamBody(
			'<img src="https://a.example/1.png" srcset="https://b.example/2.png 2x, https://c.example/3.png 3x">',
		);
		expect(fetchesSomething(out)).toBe(false);
	});

	// Older than CSS, still honoured, and still a request.
	it("knows the attributes that predate CSS", () => {
		const out = spamBody(
			'<table background="https://tracker.example/bg.png"><tr><td><img lowsrc="https://tracker.example/low.gif"></td></tr></table>',
		);
		expect(fetchesSomething(out)).toBe(false);
	});

	it("silences the things that play by themselves", () => {
		const out = spamBody(
			'<video poster="https://tracker.example/p.jpg" src="https://tracker.example/v.mp4"></video>' +
				'<audio><source src="https://tracker.example/a.mp3"></audio>' +
				'<object data="https://tracker.example/o.swf"></object>',
		);
		expect(fetchesSomething(out)).toBe(false);
	});

	it("drops a stylesheet link, which is a fetch with nothing to show", () => {
		const out = spamBody(
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
		const out = spamBody(
			'<meta http-equiv="refresh" content="0;url=https://tracker.example/opened"><p>hi</p>',
		);
		expect(fetchesSomething(out)).toBe(false);
		expect(out).toContain("hi");
	});

	it("keeps SVG from fetching through either spelling of href", () => {
		const out = spamBody(
			'<svg><image href="https://tracker.example/a.png"></image>' +
				'<image xlink:href="https://tracker.example/b.png"></image>' +
				'<use href="https://tracker.example/s.svg#i"></use></svg>',
		);
		expect(fetchesSomething(out)).toBe(false);
	});

	it("does not spare an inline attachment either", () => {
		expect(spamBody('<img src="cid:logo@example" alt="logo">')).not.toContain(
			"cid:",
		);
	});
});

describe("the CSS a spam message carries", () => {
	it("turns a background image into no background image", () => {
		const out = spamBody(
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
				fetchesSomething(spamBody(`<div style="background: ${value}">x</div>`)),
			).toBe(false);
		}
	});

	/**
	 * CSS closes what the sender left open at its end, so `url(` with no `)`
	 * is still an address. Measured: all three spellings fetched from the
	 * spam folder, because the pattern waited for a `)` that never came.
	 */
	it("catches an address the CSS never closes", () => {
		for (const value of [
			"url(https://tracker.example/a.png",
			`url("https://tracker.example/a.png`,
			"url('https://tracker.example/a.png",
			'image-set("https://tracker.example/a.png" 1x',
			"image-set(url(https://tracker.example/a.png",
		]) {
			const attribute = spamBody(
				`<div style="color:red;background:${value.replaceAll('"', "&quot;")}">x</div>`,
			);
			expect(attribute, value).not.toContain("tracker.example");
			// Mended rather than dropped: what else the style says stays.
			expect(attribute, value).toContain("color:red");
			const element = spamBody(
				`<style>.a{color:red;background:${value}</style><div class="a">x</div>`,
			);
			expect(element, value).not.toContain("tracker.example");
			expect(element, value).toContain("color:red");
			expect(element, value).toContain('<div class="a">');
		}
	});

	it("reaches inside a style block, where mail puts most of its styling", () => {
		const out = spamBody(
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
		const out = spamBody(
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
		const out = spamBody("<style>p { margin-top: 0 }</style><p>hello</p>");
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
			spamBody('<a href="https://phish.example/login">sign in</a>'),
		).toContain("https://phish.example/login");
	});

	it("leaves the words of the message exactly as they were", () => {
		const out = spamBody(
			"<p>ご請求金額のお知らせ</p><blockquote>元のメール</blockquote>",
		);
		expect(out).toContain("ご請求金額のお知らせ");
		expect(out).toContain("<blockquote>元のメール</blockquote>");
	});

	it("copes with an empty body", () => {
		expect(spamBody("").trim()).toBe("");
	});
});

/**
 * These are here because these rules are the only thing standing between a
 * spam message and its sender's server. A frame policy would have caught what
 * a rewrite is worst at, and neither way of giving a `srcdoc` frame one held
 * a fetch back when measured -- a `<meta http-equiv="Content-Security-Policy">`
 * first in its head, or the iframe's `csp` attribute. So the spellings a
 * regular expression is likeliest to miss get their own cases.
 */
describe("the spellings a rewrite is worst at", () => {
	it("catches an image-set that names its addresses as bare strings", () => {
		const out = spamBody(
			`<div style='background-image: image-set("https://tracker.example/a.png" 1x, "https://tracker.example/b.png" 2x)'>x</div>`,
		);
		expect(fetchesSomething(out)).toBe(false);
	});

	it("catches one wrapped around url(), without leaving the wrapper behind", () => {
		const out = spamBody(
			'<div style="background-image: -webkit-image-set(url(https://tracker.example/a.png) 1x)">x</div>',
		);
		expect(fetchesSomething(out)).toBe(false);
		expect(out).not.toContain("image-set");
	});

	it("catches an @import that puts its address inside url()", () => {
		const out = spamBody(
			"<style>@import url(https://tracker.example/mail.css); p{margin:0}</style>",
		);
		expect(fetchesSomething(out)).toBe(false);
		expect(out).not.toContain("@import");
	});
});

/**
 * CSS lets any character of a name be written as an escape, and a browser
 * reads the escape. Measured: every one of these fetched from the spam
 * folder while the patterns matched only what was written.
 */
describe("CSS that spells its fetch in escapes", () => {
	const hidden = [
		[
			"an escaped letter in url(",
			"background:u\\rl(https://tracker.example/1.gif)",
		],
		[
			"a hex escape in url(",
			"background:u\\72 l(https://tracker.example/2.gif)",
		],
		[
			"a capital hex escape",
			"background:\\55 RL(https://tracker.example/3.gif)",
		],
		[
			"an escaped image-set(",
			'background:im\\61ge-set("https://tracker.example/4.gif" 1x)',
		],
	];
	for (const [label, css] of hidden) {
		it(`sees through ${label} in a style attribute`, () => {
			const out = spamBody(
				`<div style="${css.replaceAll('"', "&quot;")}">x</div>`,
			);
			expect(out).not.toContain("tracker.example");
			// Mended, not given up on: the last resort would also have no
			// address in it, and no <div> either.
			expect(out).toContain("<div");
		});
		it(`sees through ${label} in a style element`, () => {
			const out = spamBody(`<style>.a{${css}}</style><div class="a">x</div>`);
			expect(out).not.toContain("tracker.example");
			expect(out).toContain('<div class="a">');
		});
	}

	it("sees through an escaped @import", () => {
		const out = spamBody(
			'<style>@\\69mport "https://tracker.example/i.css"; p{margin:0}</style><p>x</p>',
		);
		expect(out).not.toContain("tracker.example");
	});

	/**
	 * And leaves the escapes that are there for a reason. Japanese mail names
	 * its fonts this way constantly; dropping the rule would change how every
	 * such message looks for no gain.
	 */
	it("keeps an escaped font name that fetches nothing", () => {
		const css = 'font-family:"\\30E1\\30A4\\30EA\\30AA";color:red';
		const out = spamBody(`<p style='${css}'>本文</p>`);
		expect(out).toContain("\\30E1\\30A4\\30EA\\30AA");
		expect(out).toContain("color:red");
	});

	it("reads escapes the way CSS Syntax says to", () => {
		expect(decodeCssEscapes("u\\rl(")).toBe("url(");
		expect(decodeCssEscapes("u\\72 l(")).toBe("url(");
		expect(decodeCssEscapes("\\30E1\\30A4")).toBe("メイ");
		expect(decodeCssEscapes("a\\0 b")).toBe("a\uFFFDb");
		expect(decodeCssEscapes("no escapes")).toBe("no escapes");
	});
});

/**
 * SVG attributes are CSS too. Measured: `mask=`, `filter=`, `clip-path=` and
 * `cursor=` fetched from the spam folder, because only `style` was read.
 */
describe("SVG attributes that take url()", () => {
	it("takes an outside address off each of them", () => {
		const out = spamBody(
			'<svg><rect mask="url(https://tracker.example/m.svg#m)" filter="url(https://tracker.example/f.svg#f)"' +
				' clip-path="url(https://tracker.example/c.svg#c)" cursor="url(https://tracker.example/c.png), auto"' +
				' marker-end="u\\rl(https://tracker.example/k.svg#k)" width="9" height="9"/></svg>',
		);
		expect(out).not.toContain("tracker.example");
		expect(out).toContain("<rect");
	});

	it("leaves a reference to something inside the message", () => {
		const out = spamBody(
			'<svg><defs><linearGradient id="g"></linearGradient></defs><rect fill="url(#g)" width="9" height="9"/></svg>',
		);
		expect(out).toContain('fill="url(#g)"');
	});

	/**
	 * Read as CSS the same way in a style, and kept the same way: rewriting
	 * `url(#g)` to `none` took an SVG's own gradient away and fetched nothing
	 * less.
	 */
	it("leaves a reference inside the message in CSS too", () => {
		const attribute = spamBody(
			'<svg><rect style="fill:url(#g);stroke:url( \'#s\' )" width="9" height="9"/></svg>',
		);
		expect(attribute).toContain("fill:url(#g)");
		expect(attribute).toContain("stroke:url( '#s' )");
		const element = spamBody(
			'<style>.a{fill:url("#g")}</style><svg><rect class="a" width="9" height="9"/></svg>',
		);
		expect(element).toContain('fill:url("#g")');
	});

	/**
	 * An animation of one of these is taken away only when it would give it
	 * an address. A colour changing is not a fetch.
	 */
	it("leaves an animation that sets no address", () => {
		const out = spamBody(
			'<svg><rect width="9" height="9"><animate attributeName="fill" from="red" to="blue" dur="1s"/>' +
				'<animate attributeName="stroke" values="red;url(#g);blue" dur="1s"/></rect></svg>',
		);
		expect(out).toContain('attributeName="fill"');
		expect(out).toContain('attributeName="stroke"');
	});

	it("takes away one that sets an address in any of its values", () => {
		for (const values of [
			'values="red;url(https://tracker.example/m.svg#m)"',
			'from="url(https://tracker.example/m.svg#m)" to="red"',
			'by="url(https://tracker.example/m.svg#m)"',
		]) {
			const out = spamBody(
				`<svg><rect width="9" height="9"><animate attributeName="fill" ${values} dur="1s"/></rect></svg>`,
			);
			expect(out, values).not.toContain("tracker.example");
			expect(out, values).toContain("<rect");
		}
	});

	it("does not let an animation put one back", () => {
		const out = spamBody(
			'<svg><rect width="9" height="9"><set attributeName="mask" to="url(https://tracker.example/m.svg#m)"/></rect></svg>',
		);
		expect(out).not.toContain("tracker.example");
	});

	it("takes the address off an feImage, in either spelling", () => {
		const out = spamBody(
			'<svg><filter id="f"><feImage href="https://tracker.example/a.gif"/>' +
				'<feImage xlink:href="https://tracker.example/b.gif"/></filter></svg>',
		);
		expect(out).not.toContain("tracker.example");
	});
});

/**
 * `url(#...)` fetches nothing and is kept -- and every way of hiding a real
 * address behind one. A pattern pairs an `url(` with the wrong `)` when a
 * comment or a string sits between them; measured, each of these fetched
 * from the spam folder while the match the rule looked at began with `#`.
 *
 * Each case also says what has to be left once the address is gone, because
 * "no address and an element still there" is just as true of CSS dropped
 * whole -- measured, these tests passed with every such stylesheet emptied.
 */
describe("an address hidden behind url(#", () => {
	const hidden = [
		[
			"a comment in a style attribute",
			'<div style="color:red;/*url(#*/background:url(https://tracker.example/1.gif)">x</div>',
			"color:red",
		],
		[
			"a comment, with the address in escapes",
			'<div style="color:red;/*url(#*/background:u\\rl(https://tracker.example/10.gif)">x</div>',
			"color:red",
		],
		[
			"a comment in an SVG style",
			'<svg><rect width="9" height="9" style="color:red;/*url(#*/fill:url(https://tracker.example/2.svg#m)"/></svg>',
			"color:red",
		],
		[
			"a string in a style attribute",
			`<div style="color:red;content:'url(&quot;#';background:url(https://tracker.example/3.gif)">x</div>`,
			"color:red",
		],
		[
			"a string in a style element",
			`<style>.k{color:red}.a{content:"url('#"}.b{background:url(https://tracker.example/4.gif)}</style><div class="b">x</div>`,
			".k{color:red}",
		],
		[
			"a string ended by a newline",
			'<style>.k{color:red}.a{fill:url("#g\n);}.b{background:url(https://tracker.example/5.gif)}</style><div class="b">x</div>',
			".k{color:red}",
		],
		[
			"an animation's list of values",
			'<svg><rect width="9" height="9"><animate attributeName="mask" values="url(#a;url(https://tracker.example/6.svg#m)" dur="1s"/></rect></svg>',
			"<rect",
		],
		[
			"a comment in an SVG attribute",
			'<svg><rect width="9" height="9" mask="/*url(#*/url(https://tracker.example/7.svg#m)"/></svg>',
			"<rect",
		],
	];
	for (const [label, html, kept] of hidden) {
		it(`is found behind ${label}`, () => {
			const out = spamBody(html);
			expect(out).not.toContain("tracker.example");
			expect(out).toContain(kept);
		});
	}
});

/**
 * A `<style>` inside `<svg>` may have child elements, and the browser builds
 * the sheet from the style's own text only. Measured in Chromium: both of
 * these fetched, because the check read the children's text as well.
 */
describe("a <style> with elements in it", () => {
	for (const [label, css] of [
		[
			"splitting url(#x) from its address",
			"url(<g>#x) </g>https://tracker.example/8.gif)",
		],
		[
			"splitting the word url itself",
			"u<g>x</g>rl(https://tracker.example/9.gif)",
		],
	]) {
		it(`is read as the browser reads it, ${label}`, () => {
			const out = spamBody(
				`<svg><style>.k{color:red}.a{background:${css}}</style></svg><div class="a">x</div>`,
			);
			expect(out).not.toContain("tracker.example");
			expect(out).toContain(".k{color:red}");
		});
	}
});

/**
 * CSS skips space, tab and line breaks after `url(`, and nothing else. A
 * no-break space or U+3000 before `#` makes a relative address, which the
 * browser fetched -- measured, from this application's own origin.
 */
describe("a space CSS does not skip", () => {
	// Read from the attributes, not from serialised markup: innerHTML writes
	// U+00A0 as `&nbsp;`, so a search of it for the character itself passed
	// with the fix taken out -- measured, for this half of the test.
	for (const space of ["\u00a0", "\u3000"]) {
		it(`is not taken for one, ${JSON.stringify(space)}`, () => {
			const div = spamDocument(
				`<div style="color:red;background:url(${space}#x)">x</div>`,
			).querySelector("div");
			expect(div?.getAttribute("style")).not.toContain(`url(${space}`);
			expect(div?.getAttribute("style")).toContain("color:red");
			const rect = spamDocument(
				`<svg><rect width="9" height="9" mask="url(${space}#m)"/></svg>`,
			).querySelector("rect");
			expect(rect).not.toBeNull();
			expect(rect?.hasAttribute("mask")).toBe(false);
		});
	}
});

/**
 * Where the CSS has to be rewritten, a reference into the message still
 * stays. Rewriting every address took a whole sheet's gradients and clips
 * away for one `url(http://...)` mentioned in a comment.
 */
describe("a reference into the message, beside something that fetches", () => {
	it("stays when the other is only mentioned in a comment", () => {
		const out = spamBody(
			"<style>/* see url(http://x.example/) */ .g{fill:url(#grad)} .c{clip-path:url(#clip)}</style><p>x</p>",
		);
		expect(out).not.toContain("x.example");
		expect(out).toContain(".g{fill:url(#grad)}");
		expect(out).toContain(".c{clip-path:url(#clip)}");
	});

	it("stays beside a tracker in the same style", () => {
		const out = spamBody(
			'<svg><rect width="9" height="9" style="fill:url(#g);background:url(https://tracker.example/a.gif)"/></svg>',
		);
		expect(out).not.toContain("tracker.example");
		expect(out).toContain("fill:url(#g)");
	});
});
