import { describe, expect, it } from "vitest";
import {
	linkifyPlainUrls,
	neutralizeLinks,
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
 * Built with createHTMLDocument rather than DOMParser so the document has a
 * real base URL, which is what a relative href in a message resolves against.
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
	 * be what runs. EmailIframe.vue returns before it.
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
