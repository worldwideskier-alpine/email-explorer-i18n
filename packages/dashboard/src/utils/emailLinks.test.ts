import { describe, expect, it } from "vitest";
import {
	frameDocument,
	linkifyPlainUrls,
	neutralizeLinks,
	prepareFrame,
	sendLinksToANewTab,
} from "./emailLinks";

/**
 * A link in a message must never take the message away.
 *
 * The report was "press the link and it breaks", with a picture of a grey
 * panel and a torn page where the mail had been. Reproduced in Chromium
 * against a destination sending `X-Frame-Options: DENY`: a sender's own
 * anchor carries no target, so the click navigated the frame, the destination
 * refused to be framed, and `chrome-error://chromewebdata/` took the message's
 * place. Nothing about that is particular to that sender -- it is every link
 * in every HTML message that does not happen to say `target`.
 *
 * What is asked for here is therefore a property of the body, not of a click
 * handler: after these passes, no link that leaves the application is left in
 * a state where pressing it could load anything into this frame. A handler
 * cannot make that claim -- a middle click, a long press and "open in new
 * tab" all go around one.
 *
 * And it has to be a property of the body *as the parser receives it*, which
 * is what the last group in this file is about and what two deploys got
 * wrong. Applying it in the frame's `load` handler is too late by however
 * long the sender's slowest image takes.
 *
 * The DOM-level tests build their documents with createHTMLDocument, which
 * under jsdom has no base URL at all -- measured, a relative href on one
 * reads back as "/inbox", where a DOMParser document in the same run resolves
 * it against the test page. That is why bodyOf states a `<base>`. The rule
 * that decides "leaves the app" no longer depends on either: see ANY_BASE.
 */

function bodyOf(html: string): Document {
	const doc = document.implementation.createHTMLDocument("message");
	// A `srcdoc` document has no address of its own and resolves relative
	// URLs against the page that holds it. jsdom gives a document built this
	// way no base at all, so it is stated, and a relative href then resolves
	// the way it would in the frame.
	const base = doc.createElement("base");
	base.href = "https://mail.example/inbox";
	doc.head.appendChild(base);
	doc.body.innerHTML = html;
	return doc;
}

const link = (doc: Document, selector = "a") =>
	doc.body.querySelector(selector) as HTMLAnchorElement;

describe("where a link goes", () => {
	it("sends a sender's own link, which says nothing, to a new tab", () => {
		const doc = bodyOf(
			'<p>配信設定の変更は<a href="https://example.com/unsub">こちら</a></p>',
		);
		expect(link(doc).target).toBe("");

		sendLinksToANewTab(doc);

		expect(link(doc).target).toBe("_blank");
		// What window.open(..., "noopener,noreferrer") was asking for, kept:
		// no handle back to this window, and no Referer.
		expect(link(doc).rel).toBe("noopener noreferrer");
	});

	it("overrules a link that asks for this very frame", () => {
		const doc = bodyOf('<a href="https://example.com/" target="_self">x</a>');
		sendLinksToANewTab(doc);
		expect(link(doc).target).toBe("_blank");
	});

	/**
	 * `target="_top"` would replace the whole application with the sender's
	 * page. The frame is no longer given `allow-top-navigation-by-user-
	 * activation`, so it cannot happen either way -- this is the other half,
	 * so that the message never even asks.
	 */
	it("overrules a link that asks for the whole window", () => {
		const doc = bodyOf('<a href="https://example.com/" target="_top">x</a>');
		sendLinksToANewTab(doc);
		expect(link(doc).target).toBe("_blank");
	});

	it("covers an image map, which is a link with another name", () => {
		const doc = bodyOf(
			'<img src="b.png" usemap="#m"><map name="m">' +
				'<area shape="rect" coords="0,0,9,9" href="https://example.com/a"></map>',
		);
		sendLinksToANewTab(doc);
		const area = link(doc, "area") as unknown as HTMLAreaElement;
		expect(area.target).toBe("_blank");
		expect(area.rel).toBe("noopener noreferrer");
	});

	/**
	 * A relative href in a message resolves against this application's own
	 * address, because that is the base a `srcdoc` document inherits. Loading
	 * it in the frame would put the app inside itself.
	 */
	it("sends a relative link out too, since it resolves to this app", () => {
		const doc = bodyOf('<a href="/inbox">x</a>');
		sendLinksToANewTab(doc);
		expect(link(doc).target).toBe("_blank");
	});

	/**
	 * And in a document with no base at all. createHTMLDocument under jsdom is
	 * one -- a relative href reads back as "/inbox" from `.href` -- which is
	 * why the old rule, which read `.href`, needed bodyOf's `<base>` to pass.
	 * The decision is made against a fixed base now, so it does not.
	 */
	it("sends a relative link out even where nothing resolves it", () => {
		const doc = document.implementation.createHTMLDocument("no base");
		doc.body.innerHTML = '<a href="/inbox">x</a>';
		sendLinksToANewTab(doc);
		expect(link(doc).getAttribute("target")).toBe("_blank");
	});

	it("leaves a jump within the message where it is", () => {
		// `_blank` on this would open about:srcdoc in a tab: a blank page.
		const doc = bodyOf('<a href="#footer">下へ</a>');
		sendLinksToANewTab(doc);
		expect(link(doc).target).toBe("");
		expect(link(doc).rel).toBe("");
	});

	it("leaves the ones the operating system answers", () => {
		// These hand off to a mail client or a dialler; the frame keeps its
		// content either way, so there is nothing to protect it from.
		const doc = bodyOf(
			'<a href="mailto:info@example.com">mail</a><a href="tel:+81000">tel</a>',
		);
		sendLinksToANewTab(doc);
		for (const anchor of doc.body.querySelectorAll("a")) {
			expect(anchor.target).toBe("");
		}
	});

	it("does not fall over on a body with nothing in it", () => {
		const doc = bodyOf("");
		expect(() => sendLinksToANewTab(doc)).not.toThrow();
	});
});

describe("a bare URL in the text", () => {
	it("becomes a link, and that link leaves like the others", () => {
		const doc = bodyOf(
			"<pre>詳しくは https://example.com/a をご覧ください</pre>",
		);
		linkifyPlainUrls(doc);
		sendLinksToANewTab(doc);

		const anchor = link(doc);
		expect(anchor.getAttribute("href")).toBe("https://example.com/a");
		expect(anchor.target).toBe("_blank");
		expect(anchor.rel).toBe("noopener noreferrer");
	});

	it("does not swallow the punctuation that follows it", () => {
		const doc = bodyOf(
			"<pre>詳しくは https://example.com/a. をご覧ください</pre>",
		);
		linkifyPlainUrls(doc);
		expect(link(doc).getAttribute("href")).toBe("https://example.com/a");
		expect(doc.body.textContent).toContain(". をご覧ください");
	});

	/**
	 * And does not swallow the sentence either, which is how a Japanese one
	 * follows a URL: no space between them. `https://example.com/a）です。`
	 * was taken whole, and the link led nowhere -- one more way a link breaks
	 * when it is pressed.
	 */
	it("stops where the URL stops, with no space to tell it to", () => {
		const doc = bodyOf("<pre>こちら（https://example.com/a）です。</pre>");
		linkifyPlainUrls(doc);
		expect(link(doc).getAttribute("href")).toBe("https://example.com/a");
		expect(link(doc).textContent).toBe("https://example.com/a");
		expect(doc.body.textContent).toContain("）です。");
	});

	it("leaves a URL that is already a link alone", () => {
		const doc = bodyOf(
			'<a href="https://example.com/a">https://example.com/a</a>',
		);
		linkifyPlainUrls(doc);
		expect(doc.body.querySelectorAll("a")).toHaveLength(1);
	});
});

describe("a message in the spam folder", () => {
	/**
	 * The opposite requirement, and it has to stay the opposite: here the
	 * point is that nothing can be reached at all, so the sweep above must not
	 * be what runs. prepareLinks picks between them.
	 */
	it("has nothing left to press", () => {
		const doc = bodyOf(
			'<a href="https://phish.example/" target="_blank">銀行</a>' +
				'<map name="m"><area href="https://phish.example/a"></map>',
		);
		neutralizeLinks(doc);

		for (const element of doc.body.querySelectorAll("a, area")) {
			expect(element.hasAttribute("href")).toBe(false);
			expect(element.hasAttribute("target")).toBe(false);
		}
		// The words stay: a message one is deciding about has to be readable.
		expect(doc.body.textContent).toContain("銀行");
	});
});

/**
 * What the frame builds from what it is handed.
 *
 * Every test below reads prepareFrame's output back through a fresh
 * DOMParser, which is what the frame itself does with it. Asking the tree
 * prepareFrame worked on would be asking the wrong tree: the whole point of
 * the second reading is that the two can differ.
 */
const XLINK = "http://www.w3.org/1999/xlink";
const framed = (body: string, disable = false) =>
	new DOMParser().parseFromString(prepareFrame(body, { disable }), "text/html");
const destinationOf = (element: Element) =>
	element.getAttribute("href") ?? element.getAttributeNS(XLINK, "href");

/** The property the frame has to have, stated independently of the code. */
function frameIsSafe(doc: Document, disable: boolean): boolean {
	return [...doc.querySelectorAll("*")].every((element) => {
		const to = destinationOf(element);
		if (to === null) return true;
		if (disable) return false;
		if (to.trim().startsWith("#")) return true;
		const scheme = new URL(to, "https://any.invalid/").protocol;
		return (
			!/^https?:$/.test(scheme) || element.getAttribute("target") === "_blank"
		);
	});
}

describe("what the frame is handed", () => {
	/**
	 * The contract the first two attempts got wrong: this is asked of the
	 * *markup*, because the markup is what the parser turns into a tappable
	 * page. Both earlier versions applied the rule in the frame's `load`
	 * handler, which does not run until every image in the message has
	 * arrived -- measured in Chromium, three seconds into a message with one
	 * slow picture the text was tappable and the links untouched.
	 */
	it("carries the target in the markup, before anything is parsed", () => {
		const html = prepareFrame(
			'<p>配信設定の変更は<a href="https://example.com/unsub">こちら</a></p>' +
				'<img src="https://example.com/slow.png">',
		);
		expect(html).toMatch(
			/<a href="https:\/\/example\.com\/unsub" target="_blank" rel="noopener noreferrer">/,
		);
		// The picture that held the load event back is not the fix's business.
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

	it("hands the spam folder a body with no destination left in it", () => {
		const doc = framed(
			'<a href="https://phish.example/">銀行</a>' +
				'<map name="m"><area href="https://phish.example/a"></map>',
			true,
		);
		expect(frameIsSafe(doc, true)).toBe(true);
		expect(doc.body.textContent).toContain("銀行");
		// The anchor is still there, only inert: not the text-only fallback.
		expect(doc.querySelector("a")).not.toBeNull();
		expect(doc.querySelector("pre")).toBeNull();
	});

	/**
	 * A regression the previous version introduced, measured in Chromium: it
	 * parsed the body on its own and returned `head + body`, so the message's
	 * `<body>` attributes were thrown away. A black newsletter with white
	 * text came out on this frame's light grey. In the frame the parser merges
	 * those attributes onto the body it already has, and now the same parse
	 * happens here.
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

	it("keeps the message's own stylesheet", () => {
		const doc = framed(
			'<html><head><style>.b { color: red }</style></head><body><p class="b">hello</p></body></html>',
		);
		expect(
			[...doc.querySelectorAll("style")].map((el) => el.textContent).join(),
		).toContain(".b { color: red }");
		expect(doc.body.textContent).toContain("hello");
	});

	/**
	 * Linkifying is a convenience, and a throw from it once took the whole
	 * message off the screen -- measured, no frame at all, only a Vue render
	 * error. The failure is simulated at the tree walker it uses.
	 */
	it("still shows the message, links decided, if linkifying throws", () => {
		const original = Document.prototype.createTreeWalker;
		const logged = console.error;
		console.error = () => {};
		// Only the text-node walk linkifying does. jsdom's own
		// querySelectorAll walks elements with this same method, so failing
		// every call would break the sweep too -- which no browser would do,
		// its selector engine being native.
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

	/**
	 * `.href` on an SVG `<a>` is an SVGAnimatedString, not a string, and the
	 * test against it said "stays here". Measured: clicking one navigated the
	 * frame. Both spellings of the attribute, since SVG accepts `xlink:href`.
	 */
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
	 * And the spam folder's side: `xlink:href` survived removeAttribute("href")
	 * and, measured, clicking it navigated the frame to the phishing address.
	 */
	it("takes an SVG link's destination away in the spam folder", () => {
		const doc = framed(
			'<svg xmlns:xlink="http://www.w3.org/1999/xlink"><a xlink:href="https://phish.example/x"><text>Verify</text></a></svg>',
			true,
		);
		expect(frameIsSafe(doc, true)).toBe(true);
		expect(doc.body.textContent).toContain("Verify");
		// Handled, not given up on. The last resort shows the words alone,
		// which is also "no destination" -- and it hid exactly this fault
		// once, when a negative control left xlink:href in place and every
		// assertion above still passed.
		expect(doc.querySelector("svg a")).not.toBeNull();
		expect(doc.querySelector("pre")).toBeNull();
	});

	/**
	 * The one that got through in the browser, out of nine known shapes: a
	 * nested `<form>` leaves an `<a>` in the MathML namespace on the first
	 * reading, and the second reading makes it an HTML link. The frame reads
	 * the markup a second time whether anyone checks it or not.
	 */
	it("holds for a link that changes namespace between two readings", () => {
		const payload =
			'<form><math><mtext></form><form><mglyph><style></math><a href="https://example.com/m3">M3</a>';
		expect(frameIsSafe(framed(payload), false)).toBe(true);
		expect(frameIsSafe(framed(payload, true), true)).toBe(true);
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
			expect(frameIsSafe(framed(shape), false), shape).toBe(true);
			expect(frameIsSafe(framed(shape, true), true), shape).toBe(true);
		}
	});

	/**
	 * Relative, through the function production uses. Decided against a fixed
	 * base, so the answer does not depend on which document it is asked in.
	 */
	it("sends a relative link out, whatever document it is asked in", () => {
		expect(
			framed('<a href="/inbox">x</a>')
				.querySelector("a")
				?.getAttribute("target"),
		).toBe("_blank");
		expect(
			framed('<a href="//other.example/x">x</a>')
				.querySelector("a")
				?.getAttribute("target"),
		).toBe("_blank");
	});

	/**
	 * Not every href leaves. The scheme is read by the URL parser, which
	 * removes the tab in `java\tscript:` exactly as the browser will.
	 */
	it("gives a script URL no tab to run in, however it is spelled", () => {
		const doc = framed(
			'<a href="javascript:alert(1)">a</a><a href="java&#9;script:alert(1)">b</a><a href="#top">c</a>',
		);
		for (const a of doc.querySelectorAll("a")) {
			expect(a.getAttribute("target")).toBeNull();
		}
	});

	/**
	 * The last resort: markup that will not settle is shown as its words and
	 * nothing else. Simulated by making the rewrite unable to write a target
	 * at all, so every reading still has a link with nowhere to open.
	 */
	it("falls back to the words when the markup will not settle", () => {
		const original = Element.prototype.setAttribute;
		const warned = console.warn;
		console.warn = () => {};
		Element.prototype.setAttribute = function (name: string, value: string) {
			if (name === "target") return;
			original.call(this, name, value);
		};
		try {
			const doc = framed('<p>読む<a href="https://example.com/x">ここ</a></p>');
			expect(doc.querySelectorAll("a")).toHaveLength(0);
			expect(doc.body.textContent).toContain("読むここ");
		} finally {
			Element.prototype.setAttribute = original;
			console.warn = warned;
		}
	});

	/**
	 * The doctype puts the check in the frame's parsing mode. A srcdoc
	 * document is no-quirks by rule; DOMParser only is when told.
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
