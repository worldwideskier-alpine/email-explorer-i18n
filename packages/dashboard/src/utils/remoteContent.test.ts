import { describe, expect, it } from "vitest";
import { prepareFrame } from "./messageFrame";
import { cssWithoutFetches, decodeCssEscapes } from "./remoteContent";

/**
 * What the spam folder's rules guarantee, one group per guarantee:
 *
 *   1. nothing in a message fetches anything;
 *   2. CSS that fetches is rewritten to exactly this -- every address becomes
 *      `none`, or the CSS is dropped when that cannot mend it;
 *   3. CSS that fetches nothing is left exactly as it was written;
 *   4. an element or attribute that fetches loses that, and nothing else;
 *   5. the rewrite takes time in proportion to the CSS.
 *
 * Asked through prepareFrame and of the frame's own reading of what it
 * returns, because that is the document the frame shows -- and asked of that
 * document's DOM rather than of serialised markup: `innerHTML` writes U+00A0
 * as `&nbsp;`, and a search of it for the character itself passed with the
 * fix it was meant to hold taken out.
 *
 * Expectations are exact wherever they can be. "The address is gone and the
 * element is still there" is as true of CSS dropped whole as of CSS mended,
 * and tests built on it passed while testing nothing.
 */

const T = "https://tracker.example";

/** A spam message, as the frame will read it. */
function spamDocument(html: string): Document {
	return new DOMParser().parseFromString(
		prepareFrame(html, { blockRemoteContent: true }),
		"text/html",
	);
}

/** Every attribute value, text and comment in a document. */
function everythingIn(doc: Document): string[] {
	const found: string[] = [];
	const walker = doc.createTreeWalker(
		doc,
		NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT | NodeFilter.SHOW_COMMENT,
	);
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		if (node instanceof Element) {
			for (const attribute of Array.from(node.attributes)) {
				found.push(attribute.value);
			}
		} else {
			found.push((node as CharacterData).data);
		}
	}
	return found;
}

/** The style attribute of `#t` once the frame has it; null if it went. */
function styleOf(style: string): string | null {
	return (
		spamDocument(
			`<div id="t" style="${style.replaceAll('"', "&quot;")}">x</div>`,
		)
			.getElementById("t")
			?.getAttribute("style") ?? null
	);
}

/** The text of a message's own `<style>` once the frame has it. */
function sheetOf(css: string, insideSvg = false): string | null {
	const doc = spamDocument(
		insideSvg
			? `<svg><style>${css}</style></svg><p>x</p>`
			: `<style>${css}</style><p>x</p>`,
	);
	// The frame's own stylesheet comes first; the message's is the last.
	const sheets = doc.querySelectorAll("style");
	return sheets.length > 1 ? sheets[sheets.length - 1].textContent : null;
}

describe("1. nothing in a spam message fetches anything", () => {
	/**
	 * Every way of fetching that has been found, measured fetching in
	 * Chromium before it was closed. One question is asked of each: whether
	 * any attribute, text or comment in the frame's document still names the
	 * address. And that the markup was mended rather than replaced by the
	 * words alone, which would also name nothing.
	 */
	const payloads: [string, string][] = [
		["an image", `<p>hello</p><img src="${T}/pixel.gif" alt="">`],
		[
			"a hidden pixel",
			`<img src="${T}/o.gif?id=1" width="1" height="1" style="display:none">`,
		],
		[
			"every candidate in a srcset",
			`<img srcset="${T}/2.png 2x, ${T}/3.png 3x">`,
		],
		[
			"attributes older than CSS",
			`<table background="${T}/bg.png"><tr><td><img lowsrc="${T}/low.gif"></td></tr></table>`,
		],
		[
			"media that plays by itself",
			`<video poster="${T}/p.jpg" src="${T}/v.mp4"></video><audio><source src="${T}/a.mp3"></audio><object data="${T}/o.swf"></object>`,
		],
		[
			"a stylesheet link",
			`<link rel="stylesheet" href="${T}/mail.css"><p>hi</p>`,
		],
		[
			"a meta refresh",
			`<meta http-equiv="refresh" content="0;url=${T}/opened"><p>hi</p>`,
		],
		[
			"SVG images and uses, both spellings",
			`<svg><image href="${T}/a.png"></image><image xlink:href="${T}/b.png"></image><use href="${T}/s.svg#i"></use></svg>`,
		],
		[
			"feImage, both spellings",
			`<svg><filter id="f"><feImage href="${T}/a.gif"/><feImage xlink:href="${T}/b.gif"/></filter></svg>`,
		],
		["an inline attachment", '<img src="cid:logo@example" alt="logo">'],
		[
			"a background in a style",
			`<div style="background-image: url(${T}/bg.png); color: red">x</div>`,
		],
		[
			'url("…")',
			`<div style="background: url(&quot;${T}/a.png&quot;)">x</div>`,
		],
		["url( '…' )", `<div style="background: url( '${T}/a.png' )">x</div>`],
		["url( never closed", `<div style="background:url(${T}/a.png">x</div>`],
		[
			'url(" never closed',
			`<div style="background:url(&quot;${T}/a.png">x</div>`,
		],
		["url(' never closed", `<div style="background:url('${T}/a.png">x</div>`],
		[
			"image-set( never closed",
			`<div style="background:image-set(&quot;${T}/a.png&quot; 1x">x</div>`,
		],
		[
			"image-set(url( never closed",
			`<div style="background:image-set(url(${T}/a.png">x</div>`,
		],
		[
			"url( never closed in a style element",
			`<style>.a{background:url(${T}/a.png</style><div class="a">x</div>`,
		],
		[
			"a style element",
			`<style>.hero { background: url(${T}/hero.png) no-repeat; }</style><div class="hero">x</div>`,
		],
		[
			"@import of a string",
			`<style>@import "${T}/mail.css"; p { margin: 0 }</style><p>x</p>`,
		],
		[
			"@import of url()",
			`<style>@import url(${T}/mail.css); p{margin:0}</style><p>x</p>`,
		],
		[
			"image-set of bare strings",
			`<div style='background-image: image-set("${T}/a.png" 1x, "${T}/b.png" 2x)'>x</div>`,
		],
		[
			"-webkit-image-set of url()",
			`<div style="background-image: -webkit-image-set(url(${T}/a.png) 1x)">x</div>`,
		],
		["u\\rl(", `<div style="background:u\\rl(${T}/1.gif)">x</div>`],
		["u\\72 l(", `<div style="background:u\\72 l(${T}/2.gif)">x</div>`],
		["\\55 RL(", `<div style="background:\\55 RL(${T}/3.gif)">x</div>`],
		[
			"im\\61ge-set(",
			`<div style="background:im\\61ge-set(&quot;${T}/4.gif&quot; 1x)">x</div>`,
		],
		[
			"u\\rl( in a style element",
			`<style>.a{background:u\\rl(${T}/1.gif)}</style><div class="a">x</div>`,
		],
		[
			"@\\69mport",
			`<style>@\\69mport "${T}/i.css"; p{margin:0}</style><p>x</p>`,
		],
		[
			"SVG attributes that take url()",
			`<svg><rect mask="url(${T}/m.svg#m)" filter="url(${T}/f.svg#f)" clip-path="url(${T}/c.svg#c)" cursor="url(${T}/c.png), auto" marker-end="u\\rl(${T}/k.svg#k)" width="9" height="9"/></svg>`,
		],
		[
			"an animation's values, from and by",
			`<svg><rect width="9" height="9"><animate attributeName="fill" values="red;url(${T}/1.svg#m)" dur="1s"/><animate attributeName="fill" from="url(${T}/2.svg#m)" to="red" dur="1s"/><animate attributeName="fill" by="url(${T}/3.svg#m)" dur="1s"/></rect></svg>`,
		],
		[
			"an animation that sets one",
			`<svg><rect width="9" height="9"><set attributeName="mask" to="url(${T}/m.svg#m)"/></rect></svg>`,
		],
		[
			"url(# then a comment",
			`<div style="color:red;/*url(#*/background:url(${T}/1.gif)">x</div>`,
		],
		[
			"url(# then a comment, escaped",
			`<div style="color:red;/*url(#*/background:u\\rl(${T}/2.gif)">x</div>`,
		],
		[
			"url(#a*/ then escaped",
			`<div style="color:red;background:url(#a*/u\\rl(${T}/3.gif))">x</div>`,
		],
		[
			"url(# in an SVG style",
			`<svg><rect width="9" height="9" style="/*url(#*/fill:url(${T}/4.svg#m)"/></svg>`,
		],
		[
			"url(# in a string",
			`<div style="color:red;content:'url(&quot;#';background:url(${T}/5.gif)">x</div>`,
		],
		[
			"url(# in a string in a style element",
			`<style>.a{content:"url('#"}.b{background:url(${T}/6.gif)}</style><div class="b">x</div>`,
		],
		[
			"url(# in a string ended by a newline",
			`<style>.a{fill:url("#g\n);}.b{background:url(${T}/7.gif)}</style><div class="b">x</div>`,
		],
		[
			"url(# in an animation's list",
			`<svg><rect width="9" height="9"><animate attributeName="mask" values="url(#a;url(${T}/8.svg#m)" dur="1s"/></rect></svg>`,
		],
		[
			"url(# then a comment in an SVG attribute",
			`<svg><rect width="9" height="9" mask="/*url(#*/url(${T}/9.svg#m)"/></svg>`,
		],
		[
			"url(# in a string, escaped",
			`<svg><rect width="9" height="9" style="fill:url(#g);content:'url(#';background:u\\rl(${T}/10.gif)"/></svg>`,
		],
		[
			"an element splitting url(#x) from its address",
			`<svg><style>.a{background:url(<g>#x) </g>${T}/11.gif)}</style></svg><div class="a">x</div>`,
		],
		[
			"an element splitting the word url",
			`<svg><style>.a{background:u<g>x</g>rl(${T}/12.gif)}</style></svg><div class="a">x</div>`,
		],
		[
			"*/ inside an address",
			`<div style="background:url(${T}/a*/b'.gif);color:red">x</div>`,
		],
		[
			"a no-break space before a quote",
			`<div style="background:url(\u00a0&quot;${T}/a)b&quot;);color:red">x</div>`,
		],
	];
	for (const [label, html] of payloads) {
		it(label, () => {
			const doc = spamDocument(html);
			expect(
				everythingIn(doc).filter((value) =>
					/tracker\.example|cid:/.test(value),
				),
			).toEqual([]);
			expect(
				doc.querySelector('body > pre[style="white-space: pre-wrap"]'),
			).toBeNull();
		});
	}
});

describe("2. CSS that fetches is rewritten to exactly this", () => {
	/**
	 * Every address becomes `none` -- `url(#...)` beside it too, since the
	 * rewrite does not try to keep the look of the CSS it mends -- and an
	 * `@import` goes whole. `none` rather than nothing, so a declaration stays
	 * a declaration: `background-image: ;` is dropped as malformed, which is
	 * the same result by a less honest route. What the rewrite cannot mend is
	 * dropped: a style attribute removed (null), a `<style>` emptied.
	 */
	const inStyles: [string, string, string | null][] = [
		[
			"a background",
			`background-image: url(${T}/bg.png); color: red`,
			"background-image: none; color: red",
		],
		['url("…")', `background: url("${T}/a.png")`, "background: none"],
		["url( '…' )", `background: url( '${T}/a.png' )`, "background: none"],
		[
			"url( never closed",
			`color:red;background:url(${T}/a.png`,
			"color:red;background:none",
		],
		[
			'url(" never closed',
			`color:red;background:url("${T}/a.png`,
			"color:red;background:none",
		],
		[
			"url(' never closed",
			`color:red;background:url('${T}/a.png`,
			"color:red;background:none",
		],
		[
			"image-set( never closed",
			`color:red;background:image-set("${T}/a.png" 1x`,
			"color:red;background:none",
		],
		[
			"image-set(url( never closed",
			`color:red;background:image-set(url(${T}/a.png`,
			"color:red;background:none",
		],
		[
			"image-set of bare strings",
			`background-image: image-set("${T}/a.png" 1x, "${T}/b.png" 2x)`,
			"background-image: none",
		],
		[
			"-webkit-image-set of url()",
			`background-image: -webkit-image-set(url(${T}/a.png) 1x)`,
			"background-image: none",
		],
		[
			"an address with */ in it, whole",
			`background:url(${T}/a*/b'.gif);color:red`,
			"background:none;color:red",
		],
		[
			"url(# then a comment",
			`color:red;/*url(#*/background:url(${T}/1.gif)`,
			"color:red;/*none",
		],
		[
			"url(# then a comment, escaped",
			`color:red;/*url(#*/background:u\\rl(${T}/1.gif)`,
			"color:red;/*none",
		],
		[
			"url(#a*/ then escaped",
			`color:red;background:url(#a*/u\\rl(${T}/1.gif))`,
			"color:red;background:none)",
		],
		[
			"url(# in a string",
			`color:red;content:'url("#';background:url(${T}/1.gif)`,
			"color:red;content:'none",
		],
		[
			"url(# in a string, escaped, beside a reference",
			`fill:url(#g);content:'url(#';background:u\\rl(${T}/1.gif)`,
			"fill:none;content:'none",
		],
		[
			"url(# after a no-break space",
			"color:red;background:url(\u00a0#x)",
			"color:red;background:none",
		],
		[
			"url(# after U+3000",
			"color:red;background:url(\u3000#x)",
			"color:red;background:none",
		],
		[
			"url(# after U+FEFF",
			"color:red;background:url(\ufeff#x)",
			"color:red;background:none",
		],
		/**
		 * A no-break space is not CSS's space, so this is a bad url to the
		 * browser, which stops it at the first `)` and reads `b"` onwards as a
		 * string left open -- measured in Chromium, `color` after it was
		 * dropped with no rewrite at all. The rewrite ends the match there too.
		 */
		[
			"a no-break space before a quote",
			`background:url(\u00a0"${T}/a)b");color:red`,
			'background:noneb");color:red',
		],
		[
			"an address only escapes spell",
			`color:red;background:u\\rl(${T}/1.gif)`,
			null,
		],
		[
			"an image-set only escapes spell",
			`background:im\\61ge-set("${T}/4.gif" 1x)`,
			null,
		],
	];
	for (const [label, style, rewritten] of inStyles) {
		it(`in a style attribute: ${label}`, () => {
			expect(styleOf(style)).toBe(rewritten);
		});
	}

	const inSheets: [string, string, string][] = [
		[
			"url( never closed",
			`.a{color:red;background:url(${T}/a.png`,
			".a{color:red;background:none",
		],
		[
			"a background",
			`.hero { background: url(${T}/hero.png) no-repeat; }`,
			".hero { background: none no-repeat; }",
		],
		[
			"@import of a string",
			`@import "${T}/mail.css"; p { margin: 0 }`,
			" p { margin: 0 }",
		],
		[
			"@import of url()",
			`@import url(${T}/mail.css); p{margin:0}`,
			" p{margin:0}",
		],
		[
			"url(# in a string",
			`.k{color:red}.a{content:"url('#"}.b{background:url(${T}/4.gif)}`,
			'.k{color:red}.a{content:"none}',
		],
		[
			"url(# in a string ended by a newline",
			`.k{color:red}.a{fill:url("#g\n);}.b{background:url(${T}/5.gif)}`,
			".k{color:red}.a{fill:none;}.b{background:none}",
		],
		[
			"a reference beside a mention in a comment",
			"/* see url(http://x.example/) */ .g{fill:url(#grad)}",
			"/* see none */ .g{fill:none}",
		],
		[
			"an address only escapes spell",
			`.k{color:red}.a{background:u\\rl(${T}/1.gif)}`,
			"",
		],
		[
			"an @import only escapes spell",
			`@\\69mport "${T}/i.css"; p{margin:0}`,
			"",
		],
	];
	for (const [label, css, rewritten] of inSheets) {
		it(`in a style element: ${label}`, () => {
			expect(sheetOf(css)).toBe(rewritten);
		});
	}

	/**
	 * Inside `<svg>` a `<style>` can hold elements, and the browser builds the
	 * sheet from the style's own text only -- measured, Chromium fetched both
	 * of these. So the rewrite reads the same text, and writes back text alone.
	 */
	for (const [label, css] of [
		[
			"an element splitting url(#x) from its address",
			`.k{color:red}.a{background:url(<g>#x) </g>${T}/8.gif)}`,
		],
		[
			"an element splitting the word url",
			`.k{color:red}.a{background:u<g>x</g>rl(${T}/9.gif)}`,
		],
	]) {
		it(`in a style element inside <svg>: ${label}`, () => {
			expect(sheetOf(css, true)).toBe(".k{color:red}.a{background:none}");
		});
	}
});

describe("3. CSS that fetches nothing is left exactly as written", () => {
	for (const style of [
		"color: red",
		"fill:url(#g);stroke:url( '#s' )",
		// Japanese mail names its fonts this way constantly.
		'font-family:"\\30E1\\30A4\\30EA\\30AA";color:red',
	]) {
		it(`a style attribute: ${style}`, () => {
			expect(styleOf(style)).toBe(style);
		});
	}

	for (const css of [
		'.a{fill:url("#g")}',
		"/* url(#x) */ p{color:red}",
		"p { margin-top: 0 }",
	]) {
		it(`a style element: ${css}`, () => {
			expect(sheetOf(css)).toBe(css);
		});
	}

	/**
	 * The parser moves a leading `<style>` into the head, and Outlook opens
	 * every message it sends with one; it has to stay, and stay first.
	 */
	it("a style element the parser moved into the head", () => {
		const doc = spamDocument("<style>p { margin-top: 0 }</style><p>hello</p>");
		const sheet = doc.querySelectorAll("style")[1];
		expect(sheet.textContent).toBe("p { margin-top: 0 }");
		expect(
			sheet.compareDocumentPosition(doc.querySelector("p") as Element) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("an SVG attribute that points into the message", () => {
		const rect = spamDocument(
			'<svg><defs><linearGradient id="g"></linearGradient></defs><rect fill="url(#g)" width="9" height="9"/></svg>',
		).querySelector("rect");
		expect(rect?.getAttribute("fill")).toBe("url(#g)");
	});

	/** A colour changing is not a fetch; nor is a list of them with a reference in it. */
	it("an animation that sets no address", () => {
		const animations = spamDocument(
			'<svg><rect width="9" height="9"><animate attributeName="fill" from="red" to="blue" dur="1s"/>' +
				'<animate attributeName="stroke" values="red;url(#g);blue" dur="1s"/></rect></svg>',
		).querySelectorAll("animate");
		expect(
			Array.from(animations).map((animation) => [
				animation.getAttribute("attributeName"),
				animation.getAttribute("from"),
				animation.getAttribute("to"),
				animation.getAttribute("values"),
			]),
		).toEqual([
			["fill", "red", "blue", null],
			["stroke", null, null, "red;url(#g);blue"],
		]);
	});
});

describe("4. what fetches is taken away, and nothing else", () => {
	it("an image keeps everything but its address", () => {
		const img = spamDocument(
			`<img src="${T}/logo.png" srcset="${T}/2.png 2x" lowsrc="${T}/l.gif" alt="SAISON" width="1">`,
		).querySelector("img");
		expect(img && Array.from(img.attributes, (a) => [a.name, a.value])).toEqual(
			[
				["alt", "SAISON"],
				["width", "1"],
			],
		);
	});

	it("a table keeps everything but its background", () => {
		const table = spamDocument(
			`<table background="${T}/bg.png" width="600"><tr><td>x</td></tr></table>`,
		).querySelector("table");
		expect(table && Array.from(table.attributes, (a) => a.name)).toEqual([
			"width",
		]);
	});

	it("media keep everything but their addresses", () => {
		const doc = spamDocument(
			`<video poster="${T}/p.jpg" src="${T}/v.mp4" width="320"></video><audio><source src="${T}/a.mp3" type="audio/mpeg"></audio>`,
		);
		expect(
			Array.from(doc.querySelector("video")?.attributes ?? [], (a) => a.name),
		).toEqual(["width"]);
		expect(
			Array.from(doc.querySelector("source")?.attributes ?? [], (a) => a.name),
		).toEqual(["type"]);
	});

	it("a stylesheet link and a meta refresh go whole, and the words stay", () => {
		const doc = spamDocument(
			`<link rel="stylesheet" href="${T}/mail.css"><meta http-equiv="refresh" content="0;url=${T}/o"><p>hi</p>`,
		);
		expect(doc.querySelectorAll("link, meta[http-equiv]")).toHaveLength(0);
		expect(doc.querySelector("p")?.textContent).toBe("hi");
	});

	it("SVG that loads by href keeps everything but the href", () => {
		const doc = spamDocument(
			`<svg><image href="${T}/a.png" width="9"></image><use xlink:href="${T}/s.svg#i" x="1"></use>` +
				`<filter id="f"><feImage href="${T}/a.gif" result="r"/></filter></svg>`,
		);
		expect(
			Array.from(doc.querySelectorAll("image, use, feImage"), (element) =>
				Array.from(element.attributes, (a) => a.name),
			),
		).toEqual([["width"], ["x"], ["result"]]);
	});

	it("an SVG shape keeps everything but the attributes that fetch", () => {
		const rect = spamDocument(
			`<svg><rect mask="url(${T}/m.svg#m)" filter="url(${T}/f.svg#f)" clip-path="url(${T}/c.svg#c)" cursor="url(${T}/c.png), auto" marker-end="u\\rl(${T}/k.svg#k)" fill="url(#g)" width="9"/></svg>`,
		).querySelector("rect");
		expect(
			rect && Array.from(rect.attributes, (a) => [a.name, a.value]),
		).toEqual([
			["fill", "url(#g)"],
			["width", "9"],
		]);
	});

	it("an animation that sets an address goes, and its shape stays", () => {
		const doc = spamDocument(
			`<svg><rect width="9"><set attributeName="mask" to="url(${T}/m.svg#m)"/><animate attributeName="fill" from="red" to="blue" dur="1s"/></rect></svg>`,
		);
		expect(doc.querySelector("set")).toBeNull();
		expect(
			doc.querySelector("rect animate")?.getAttribute("attributeName"),
		).toBe("fill");
	});

	/**
	 * Links are a separate rule: nothing fetches until one is pressed, and a
	 * reader deciding about a message may want to see where it points.
	 */
	it("a link's destination stays readable", () => {
		expect(
			spamDocument('<a href="https://phish.example/login">sign in</a>')
				.querySelector("a")
				?.getAttribute("href"),
		).toBe("https://phish.example/login");
	});

	it("the words of the message stay exactly as they were, in their elements", () => {
		const doc = spamDocument(
			"<p>ご請求金額のお知らせ</p><blockquote>元のメール</blockquote>",
		);
		expect(
			Array.from(doc.body.children, (element) => [
				element.localName,
				element.textContent,
			]),
		).toEqual([
			["p", "ご請求金額のお知らせ"],
			["blockquote", "元のメール"],
		]);
	});

	it("an empty body stays empty", () => {
		expect(spamDocument("").body.children).toHaveLength(0);
	});
});

/**
 * A spam message is written by whoever sent it, so the length of its CSS is
 * theirs to choose. A rewrite that looked back through the whole sheet for
 * every `url(` took 8.7 seconds on 700KB of CSS, by the reviewer's
 * measurement -- a frozen tab for opening one message. Timed on the rewrite
 * alone, so that parsing the document does not decide the result; the bound
 * is loose, and only a rewrite that is not linear comes near it.
 */
describe("5. the rewrite takes time in proportion to the CSS", () => {
	for (const [label, css, rewritten] of [
		[
			"700KB of references and one tracker",
			`${"a{background:url(#g)} ".repeat(32000)}b{background:url(${T}/x)}`,
			`${"a{background:none} ".repeat(32000)}b{background:none}`,
		],
		[
			"350KB of url( left open in comments",
			`${"/* url( */ ".repeat(32000)}a{color:red}`,
			"/* none",
		],
	]) {
		it(label, () => {
			const started = performance.now();
			const result = cssWithoutFetches(css);
			expect(performance.now() - started).toBeLessThan(1000);
			expect(result).toBe(rewritten);
		});
	}
});

describe("reading CSS escapes", () => {
	it("follows CSS Syntax", () => {
		expect(decodeCssEscapes("u\\rl(")).toBe("url(");
		expect(decodeCssEscapes("u\\72 l(")).toBe("url(");
		expect(decodeCssEscapes("\\30E1\\30A4")).toBe("メイ");
		expect(decodeCssEscapes("a\\0 b")).toBe("a\uFFFDb");
		// A hex escape may end in one space -- CSS's, not a no-break space.
		expect(decodeCssEscapes("\\72\u00a0x")).toBe("r\u00a0x");
		expect(decodeCssEscapes("no escapes")).toBe("no escapes");
	});
});
