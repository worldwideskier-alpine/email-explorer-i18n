import { describe, expect, it } from "vitest";
import { frameDocument, prepareFrame } from "./messageFrame";

/**
 * What the frame builds from what it is handed.
 *
 * Every test reads prepareFrame's output back through a fresh DOMParser,
 * which is what the frame itself does with it. Asking the tree prepareFrame
 * worked on would be asking the wrong tree: the point of the second reading
 * is that the two can differ, and each rule in messageFrame.ts is a way they
 * were measured to differ.
 *
 * `spam` mirrors the component, which sets both flags for the spam folder.
 */

const XLINK = "http://www.w3.org/1999/xlink";
const MATHML = "http://www.w3.org/1998/Math/MathML";

const framed = (body: string, spam = false) =>
	new DOMParser().parseFromString(
		prepareFrame(body, { disableLinks: spam, blockRemoteContent: spam }),
		"text/html",
	);

const destinationOf = (element: Element) =>
	element.getAttribute("href") ?? element.getAttributeNS(XLINK, "href");

/**
 * The property the frame has to have, stated independently of the code: in
 * the spam folder nothing has a destination; elsewhere every link that goes
 * anywhere but a `#fragment` or a script URL opens a tab.
 */
function linksAreSafe(doc: Document, spam: boolean): boolean {
	return [...doc.querySelectorAll("*")].every((element) => {
		const to = destinationOf(element);
		if (to === null) return true;
		if (spam) return false;
		const isLink =
			element.localName === "a" ||
			element.localName === "area" ||
			element.namespaceURI === MATHML;
		if (!isLink || to.trim() === "" || to.trim().startsWith("#")) return true;
		const scheme = new URL(to, "https://any.invalid/").protocol;
		if (scheme === "javascript:" || scheme === "vbscript:") return true;
		return element.getAttribute("target") === "_blank";
	});
}

/** Not the text-only last resort: the message's own markup survived. */
const notTheFallback = (doc: Document) =>
	doc.querySelector("body > pre") === null;

describe("what the frame is handed", () => {
	/**
	 * The contract the first two attempts got wrong: asked of the *markup*,
	 * because the markup is what the parser turns into a tappable page. Both
	 * earlier versions applied it in the frame's `load` handler, which does
	 * not run until every image has arrived.
	 */
	it("carries the target in the markup, before anything is parsed", () => {
		const html = prepareFrame(
			'<p>配信設定の変更は<a href="https://example.com/unsub">こちら</a></p>' +
				'<img src="https://example.com/slow.png">',
		);
		expect(html).toMatch(
			/<a href="https:\/\/example\.com\/unsub" target="_blank" rel="noopener noreferrer">/,
		);
		// An ordinary message keeps its pictures.
		expect(html).toContain('<img src="https://example.com/slow.png">');
	});

	it("does the same for a bare URL it had to make a link of", () => {
		const a = framed(
			"<pre>詳しくは https://example.com/a です</pre>",
		).querySelector("a");
		expect(a?.getAttribute("href")).toBe("https://example.com/a");
		expect(a?.getAttribute("target")).toBe("_blank");
		expect(a?.getAttribute("rel")).toBe("noopener noreferrer");
	});

	it("sends every scheme out but a fragment and a script", () => {
		const doc = framed(
			'<a href="mailto:a@example.com">m</a><a href="about:blank">b</a>' +
				'<a href="data:text/html,x">d</a><a href="/inbox">r</a>' +
				'<a href="javascript:alert(1)">j</a><a href="java&#9;script:alert(1)">t</a>' +
				'<a href="#top">f</a>',
		);
		const targets = Object.fromEntries(
			[...doc.querySelectorAll("a")].map((a) => [
				a.textContent,
				a.getAttribute("target"),
			]),
		);
		expect(targets).toEqual({
			m: "_blank",
			b: "_blank",
			d: "_blank",
			r: "_blank",
			j: null,
			t: null,
			f: null,
		});
	});

	it("leaves a message's <link> as it was written", () => {
		const doc = framed(
			'<link rel="stylesheet" href="https://cdn.example/mail.css"><p>x</p>',
		);
		expect(doc.querySelector("link")?.getAttribute("rel")).toBe("stylesheet");
	});

	/**
	 * A parse of the body on its own, returned as head + body, threw these
	 * away; a black newsletter with white text came out on the frame's light
	 * grey. In the frame the parser merges them onto its own body, and the
	 * same parse happens here.
	 */
	it("keeps the attributes of the message's own <body>", () => {
		const body = framed(
			'<html><body style="background:#000" class="dark" dir="rtl" bgcolor="#000000">' +
				'<p style="color:#fff">hi</p></body></html>',
		).body;
		expect(body.getAttribute("style")).toBe("background:#000");
		expect(body.className).toBe("dark");
		expect(body.dir).toBe("rtl");
		expect(body.getAttribute("bgcolor")).toBe("#000000");
	});

	/**
	 * The same in the spam folder, where remote content used to be stripped
	 * by a separate parse that returned head + body and dropped these too.
	 * What does go is the one attribute that fetches.
	 */
	it("keeps them in the spam folder, less the one that fetches", () => {
		const body = framed(
			'<html><body style="background:#000;color:#fff" dir="rtl" bgcolor="#000000" background="https://tracker.example/b.gif"><p>hi</p></body></html>',
			true,
		).body;
		expect(body.getAttribute("style")).toBe("background:#000;color:#fff");
		expect(body.dir).toBe("rtl");
		expect(body.getAttribute("bgcolor")).toBe("#000000");
		expect(body.hasAttribute("background")).toBe(false);
	});

	it("keeps the message's own stylesheet", () => {
		const doc = framed(
			'<html><head><style>.b { color: red }</style></head><body><p class="b">hello</p></body></html>',
		);
		expect(
			[...doc.querySelectorAll("style")].map((el) => el.textContent).join(),
		).toContain(".b { color: red }");
		expect(doc.body.textContent).toContain("hello");
	});

	it("hands the spam folder a body with no destination and nothing to fetch", () => {
		const doc = framed(
			'<a href="https://phish.example/">銀行</a>' +
				'<map name="m"><area href="https://phish.example/a"></map>' +
				'<img src="https://tracker.example/o.gif">',
			true,
		);
		expect(linksAreSafe(doc, true)).toBe(true);
		expect(doc.querySelector("[src]")).toBeNull();
		expect(doc.body.textContent).toContain("銀行");
		expect(doc.querySelector("a")).not.toBeNull();
		expect(notTheFallback(doc)).toBe(true);
	});

	/**
	 * Linkifying is a convenience, and a throw from it once took the whole
	 * message off the screen. Only its text-node walk fails here: jsdom's own
	 * querySelectorAll walks elements with the same method, which no
	 * browser's native selector engine would.
	 */
	it("still shows the message, links decided, if linkifying throws", () => {
		const original = Document.prototype.createTreeWalker;
		const logged = console.error;
		console.error = () => {};
		Document.prototype.createTreeWalker = function (
			this: Document,
			root: Node,
			whatToShow?: number,
			filter?: NodeFilter | null,
		) {
			if (whatToShow === NodeFilter.SHOW_TEXT) throw new Error("simulated");
			return original.call(this, root, whatToShow, filter);
		};
		try {
			const doc = framed('<p>こちら<a href="https://example.com/x">x</a></p>');
			expect(doc.body.textContent).toContain("こちら");
			expect(doc.querySelector("a")?.getAttribute("target")).toBe("_blank");
		} finally {
			Document.prototype.createTreeWalker = original;
			console.error = logged;
		}
	});

	it("sends an SVG link out too, in either spelling", () => {
		const doc = framed(
			'<svg><a href="https://shop.example/x"><text>Buy</text></a></svg>' +
				'<svg xmlns:xlink="http://www.w3.org/1999/xlink"><a xlink:href="https://shop.example/y"><text>Buy</text></a></svg>',
		);
		const links = [...doc.querySelectorAll("a")];
		expect(links).toHaveLength(2);
		for (const a of links) expect(a.getAttribute("target")).toBe("_blank");
	});

	/**
	 * WebKit makes any MathML element with an href a link, and it is not an
	 * `<a>`: the selector that finds candidates has to find it by the
	 * attribute.
	 */
	it("sends a MathML link out, and takes it away in the spam folder", () => {
		const body = '<math><mi href="https://x.example/m">m</mi></math>';
		expect(framed(body).querySelector("mi")?.getAttribute("target")).toBe(
			"_blank",
		);
		const spam = framed(body, true);
		expect(spam.querySelector("mi")?.hasAttribute("href")).toBe(false);
		expect(notTheFallback(spam)).toBe(true);
	});

	it("takes an SVG link's destination away in the spam folder", () => {
		const doc = framed(
			'<svg xmlns:xlink="http://www.w3.org/1999/xlink"><a xlink:href="https://phish.example/x"><text>Verify</text></a></svg>',
			true,
		);
		expect(linksAreSafe(doc, true)).toBe(true);
		expect(doc.querySelector("svg a")).not.toBeNull();
		expect(notTheFallback(doc)).toBe(true);
	});
});

describe("what would otherwise escape both readings", () => {
	/**
	 * Measured in Chromium: the frame's parser attaches `<template
	 * shadowrootmode>` as a live shadow root, and DOMParser does not -- so the
	 * rules and the check were looking at an inert template while the frame
	 * showed a link that navigated it, and, in the spam folder, fetched an
	 * image. Without the attribute both readings see an inert template.
	 */
	it("does not let a template become a live shadow root", () => {
		for (const spam of [false, true]) {
			const doc = framed(
				'<div><template shadowrootmode="open"><a href="https://phish.example/">Verify</a><img src="https://tracker.example/d.gif"></template></div>' +
					'<div><template shadowroot="open"><p>old spelling</p></template></div>',
				spam,
			);
			for (const template of doc.querySelectorAll("template")) {
				expect(template.hasAttribute("shadowrootmode")).toBe(false);
				expect(template.hasAttribute("shadowroot")).toBe(false);
			}
			expect(notTheFallback(doc)).toBe(true);
		}
	});

	/**
	 * Measured: `<set attributeName="href">` gave an SVG link its destination
	 * after the markup was read -- nothing saw a link, and the frame
	 * navigated -- and on an `<image>` it fetched a pixel from the spam
	 * folder. SMIL runs without scripts.
	 */
	it("does not let an animation give anything a destination", () => {
		for (const spam of [false, true]) {
			const doc = framed(
				'<svg><a><set attributeName="href" to="https://phish.example/"/><text>Click</text></a>' +
					'<image width="1" height="1"><animate attributeName="xlink:href" values="https://tracker.example/s.gif"/></image>' +
					'<a href="https://shop.example/"><set attributeName="target" to="_self"/><text>x</text></a>' +
					'<rect><animate attributeName="width" from="1" to="2"/></rect></svg>',
				spam,
			);
			const animated = [...doc.querySelectorAll("*")]
				.map((el) => el.getAttribute("attributeName"))
				.filter(Boolean);
			// Only the harmless one is left.
			expect(animated).toEqual(["width"]);
			expect(linksAreSafe(doc, spam)).toBe(true);
		}
	});

	/**
	 * Measured: a message's own `<iframe srcdoc>` is a document nothing here
	 * parsed, `frame-src` does not refuse it, and it inherits this frame's
	 * sandbox -- in the spam folder a `target="_blank"` link inside it opened
	 * the phishing page in an ordinary tab, and an image inside it was
	 * fetched.
	 */
	it("does not let a message carry a document of its own", () => {
		for (const spam of [false, true]) {
			const doc = framed(
				`<iframe srcdoc="<a href='https://phish.example/' target='_blank'>Login</a>"></iframe>` +
					'<frameset><frame src="https://x.example/"></frameset>' +
					'<object data="https://x.example/o"></object><embed src="https://x.example/e"><p>left</p>',
				spam,
			);
			expect(
				doc.querySelector("iframe, frame, frameset, object, embed"),
			).toBeNull();
			expect(doc.body.textContent).toContain("left");
			expect(notTheFallback(doc)).toBe(true);
		}
	});

	it("holds for a link that changes namespace between two readings", () => {
		const payload =
			'<form><math><mtext></form><form><mglyph><style></math><a href="https://example.com/m3">M3</a>';
		expect(linksAreSafe(framed(payload), false)).toBe(true);
		expect(linksAreSafe(framed(payload, true), true)).toBe(true);
	});

	it("holds for the rest of the known reparse shapes, both ways", () => {
		const D = "https://example.com";
		const shapes = [
			`<svg><style>&lt;/style&gt;&lt;a href="${D}/m1"&gt;M1&lt;/a&gt;</style></svg>`,
			`<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;/mglyph&gt;&lt;a href=&quot;${D}/m2&quot;&gt;M2&lt;/a&gt;">`,
			`<noscript><p title="</noscript><a href='${D}/m4'>M4</a>">x</p></noscript>`,
			`<svg><p><style><a id="</style><a href='${D}/m5'>M5</a>">`,
			`<math><annotation-xml encoding="text/html"><style>&lt;/style&gt;&lt;a href="${D}/m7"&gt;M7&lt;/a&gt;</style></annotation-xml></math>`,
			`<p><table><a href="${D}/q">quirks</a></table></p>`,
		];
		for (const shape of shapes) {
			expect(linksAreSafe(framed(shape), false), shape).toBe(true);
			const spam = framed(shape, true);
			expect(linksAreSafe(spam, true), shape).toBe(true);
			expect(spam.querySelector("[src]"), shape).toBeNull();
		}
	});
});

describe("the last resort", () => {
	/**
	 * Markup that will not settle is shown as its words and nothing else.
	 * Simulated by making the rewrite unable to write a target at all.
	 */
	function withTargetsRefused<T>(run: () => T): T {
		const original = Element.prototype.setAttribute;
		const warned = console.warn;
		console.warn = () => {};
		Element.prototype.setAttribute = function (name: string, value: string) {
			if (name === "target") return;
			original.call(this, name, value);
		};
		try {
			return run();
		} finally {
			Element.prototype.setAttribute = original;
			console.warn = warned;
		}
	}

	it("falls back to the words when the markup will not settle", () => {
		const doc = withTargetsRefused(() =>
			framed('<p>読む<a href="https://example.com/x">ここ</a></p>'),
		);
		expect(doc.querySelectorAll("a")).toHaveLength(0);
		expect(doc.body.textContent).toContain("読むここ");
	});

	/**
	 * The words, not the stylesheet and the subject line: a message's
	 * `<style>` and `<title>` land in the frame's body, and reading
	 * `textContent` as it stood put "件名.x{color:red}" ahead of the text.
	 */
	it("shows the words without the message's CSS or title", () => {
		const doc = withTargetsRefused(() =>
			framed(
				"<html><head><title>件名</title><style>.x{color:red}</style></head>" +
					'<body><p>本文です<a href="https://example.com/">こちら</a></p></body></html>',
			),
		);
		const words = doc.querySelector("pre")?.textContent ?? "";
		expect(words).toContain("本文です");
		expect(words).not.toContain("color:red");
		expect(words).not.toContain("件名");
	});
});

describe("the frame's parsing mode", () => {
	/**
	 * The doctype puts the check in the frame's mode. A srcdoc document is
	 * no-quirks by rule; DOMParser only is when told.
	 */
	it("is read in the same mode by the check as by the frame", () => {
		expect(
			new DOMParser().parseFromString(frameDocument("<p>x</p>"), "text/html")
				.compatMode,
		).toBe("CSS1Compat");
	});

	it("does not fall over on a body that is not really html", () => {
		expect(framed("").body).toBeTruthy();
		expect(framed("<p>unclosed").body.textContent).toContain("unclosed");
	});
});
