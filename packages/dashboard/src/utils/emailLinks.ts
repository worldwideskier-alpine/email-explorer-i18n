/**
 * What a link in a message may do, decided on the markup before the frame
 * ever parses it. The frame itself -- the document it is handed, and the
 * check that the frame's own reading of it holds -- is messageFrame.ts.
 *
 * Measured in Chromium, with the application's own CSP on the page:
 *
 *   - A link with no target navigates *the frame*, and the message is
 *     replaced by a browser error page. The refusal is ours before it is the
 *     destination's: the page says `frame-src 'self' blob:` and a `srcdoc`
 *     frame inherits it, so every external link ends in "This content is
 *     blocked" whatever the destination does. That grey panel is what "press
 *     the link and it breaks" was.
 *   - It has to be true from the first paint. This once ran in the frame's
 *     `load` handler, which waits for every image; three seconds into a
 *     message with one slow picture the text was tappable and the links
 *     untouched.
 */

const XLINK = "http://www.w3.org/1999/xlink";

/**
 * Where an element says it goes, whatever kind of element it is.
 *
 * Read from the attribute, not from `.href`. On an HTML anchor `.href` is the
 * resolved string; on an SVG `<a>` it is an SVGAnimatedString, and on a
 * MathML element it does not exist -- so a test against `.href` quietly
 * answered "stays here" for both, and an SVG button in a message navigated
 * the frame. SVG may also spell it `xlink:href`, which the plain attribute
 * does not see.
 */
export function destinationOf(element: Element): string | null {
	return element.getAttribute("href") ?? element.getAttributeNS(XLINK, "href");
}

const MATHML = "http://www.w3.org/1998/Math/MathML";

/**
 * Whether pressing this element can navigate anything.
 *
 * `a` and `area`, in whatever namespace -- a type selector matches SVG's and
 * MathML's `<a>` as well as HTML's, which matters because a nested-`<form>`
 * construct turns a MathML `<a>` into an HTML one when the frame reads the
 * markup again. And any MathML element with a destination, because WebKit
 * makes those links.
 *
 * Nothing else. This used to be every element, and it wrote `target` and
 * `rel` onto a `<link rel="stylesheet">` too, turning it into `rel="noopener
 * noreferrer"`. That cost nothing only by accident -- the page's
 * `style-src 'self'` had already refused the sheet, measured -- and a rule
 * that is harmless by accident is one edit away from not being.
 */
export function isLink(element: Element): boolean {
	const name = element.localName;
	if (name === "a" || name === "area") return true;
	return element.namespaceURI === MATHML && destinationOf(element) !== null;
}

/**
 * Every element that could be a link, found by the selector engine rather
 * than by walking the whole document and asking each one. `[*|href]` is an
 * `href` in any namespace -- the plain one and SVG's `xlink:href` both --
 * which is what finds a MathML link. isLink decides among them.
 */
export const LINK_CANDIDATES = "a, area, [*|href]";

/**
 * Any base will do for telling what scheme an address has, and a fixed one
 * keeps the answer from depending on the document it was asked in: `.href`
 * resolved against the application's own address in a browser, `about:blank`
 * in a document built without one, and whatever a `<base>` in the message
 * said in between.
 */
const ANY_BASE = "https://relative.invalid/";

const HTTP_PREFIX = /^https?:\/\//i;

/** The schemes that must never be given a tab of their own to run in. */
const SCRIPT_SCHEMES = new Set(["javascript:", "vbscript:"]);

/**
 * Whether a click on this has to open somewhere other than the frame.
 *
 * Everything with a destination does, except two kinds. A bare `#section` is
 * a jump within the message and stays where it is -- in a new tab it would
 * open `about:srcdoc`, a blank page. And a script URL gets no tab at all: in
 * the frame it is inert, because the frame runs no scripts.
 *
 * This was "http and https", on the reasoning that other schemes leave the
 * frame alone. Measured, they do not: `about:blank` replaced the message with
 * a blank page, and `data:`, `ftp:` and even `mailto:` ended in the same grey
 * "This content is blocked" as any external link, `frame-src` refusing the
 * navigation before anything could hand it to a mail program. The click
 * handler this replaced had opened every scheme in a new tab; narrowing it
 * to two was a regression, not a refinement.
 */
export function opensElsewhere(element: Element): boolean {
	const written = destinationOf(element)?.trim() ?? "";
	if (!written || written.startsWith("#")) return false;
	// Nearly every link in a message is spelled like this, and a string that
	// begins with it has that scheme whatever follows -- so the answer is
	// known without asking the URL parser, which was most of the cost of
	// this rule on a large message (measured, some 5 ms per pass over 900
	// links).
	if (HTTP_PREFIX.test(written)) return true;
	try {
		// The URL parser decides the scheme, not a pattern: it strips the
		// tab out of `java\tscript:` exactly as the browser will.
		return !SCRIPT_SCHEMES.has(new URL(written, ANY_BASE).protocol);
	} catch {
		// Not parseable is not navigable; the browser will not go there.
		return false;
	}
}

/**
 * Every link that goes somewhere opens a tab of its own.
 *
 * Done as an attribute rather than as a click handler, which is what this
 * replaced. A handler can only answer a left click: a middle click, a long
 * press, "open in new tab" from the context menu and a keyboard activation
 * all go around it -- and `window.open` from a handler is a popup, which a
 * browser may refuse, at which point the handler has already cancelled the
 * navigation and the link does nothing at all. `target="_blank"` is the
 * browser's own path, is not popup-blocked, and holds for every one of those
 * ways of pressing it.
 *
 * `rel` is set to what `window.open(..., "noopener,noreferrer")` was asking
 * for, so nothing about what the destination is told changes: no reference
 * back to this window, and no Referer header.
 */
export function sendLinksToANewTab(doc: Document): void {
	for (const element of doc.querySelectorAll(LINK_CANDIDATES)) {
		if (!isLink(element) || !opensElsewhere(element)) continue;
		// setAttribute rather than `.target =`: on an SVG `<a>` that property
		// is a read-only SVGAnimatedString and assigning to it throws.
		element.setAttribute("target", "_blank");
		element.setAttribute("rel", "noopener noreferrer");
	}
}

/**
 * A bare URL, spelled as the characters a URI is actually made of.
 *
 * This was "everything up to whitespace", and in Japanese it ran on: prose
 * follows a URL with no space before it, so `https://example.com/a）です。`
 * was taken whole and the link led nowhere. Trimming the punctuation off the
 * end could not save it -- `です` is not punctuation, and the trim stops at
 * the first character that is not.
 *
 * RFC 3986 says a URI is ASCII, so stopping at the first character outside
 * that set stops exactly where the sentence resumes. What it costs: a URL
 * written with Japanese in it, or an undecoded internationalised host, is
 * truncated instead of swallowed. Both are broken links; the difference is
 * that this one is rare in mail (a sending system percent-encodes or
 * punycodes) and the other was every URL followed by a word.
 *
 * `'` is left out of the set on purpose: it is legal in a URI and is far more
 * often an apostrophe in the sentence after one.
 */
const URL_PATTERN = String.raw`https?:\/\/[A-Za-z0-9\-._~:/?#\[\]@!$&()*+,;=%]+`;
// Trailing characters that are almost never actually part of the URL --
// closing punctuation the sender's prose put right after it (Japanese and
// ASCII), or a bare trailing slash-less sentence terminator.
const TRAILING_PUNCTUATION = /[.,;:!?)\]}、。）」』】]+$/;

/** Built once; without the `g` flag `test` keeps no state between calls. */
const HAS_URL = new RegExp(URL_PATTERN);

/**
 * Plain-text emails are stored as an escaped `<pre>` block (see
 * plain-text-to-html.ts) with bare URLs as plain text, and even genuine
 * HTML emails sometimes include a bare URL outside any `<a>`. Walk text
 * nodes (skipping ones already inside a link, script, or style) and wrap
 * URL-looking substrings in real `<a>` elements so they're clickable.
 *
 * Where they open is not decided here. It used to be -- this set `target` on
 * the links it made -- and that left the sender's own links as the only ones
 * without it, which is precisely the set that broke. One pass decides that
 * now, for every link in the body, and it runs after this one.
 */
export function linkifyPlainUrls(doc: Document): void {
	if (!doc.body) return;

	const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
		acceptNode(node) {
			// The pattern first: most text in a message has no URL in it, and
			// that answer is cheaper than walking up to find out whether the
			// text is already inside a link.
			if (!HAS_URL.test(node.textContent || "")) {
				return NodeFilter.FILTER_REJECT;
			}
			const parent = (node as Text).parentElement;
			return !parent || parent.closest("a, script, style")
				? NodeFilter.FILTER_REJECT
				: NodeFilter.FILTER_ACCEPT;
		},
	});

	const textNodes: Text[] = [];
	let current = walker.nextNode();
	while (current) {
		textNodes.push(current as Text);
		current = walker.nextNode();
	}

	for (const textNode of textNodes) {
		const text = textNode.textContent || "";
		const frag = doc.createDocumentFragment();
		let lastIndex = 0;

		for (const match of text.matchAll(new RegExp(URL_PATTERN, "g"))) {
			let url = match[0];
			const trailing = url.match(TRAILING_PUNCTUATION)?.[0] || "";
			url = url.slice(0, url.length - trailing.length);
			if (!url) continue;

			const start = match.index as number;
			frag.appendChild(doc.createTextNode(text.slice(lastIndex, start)));
			const anchor = doc.createElement("a");
			anchor.href = url;
			anchor.textContent = url;
			frag.appendChild(anchor);
			lastIndex = start + url.length;
		}

		if (lastIndex === 0) continue;
		frag.appendChild(doc.createTextNode(text.slice(lastIndex)));
		textNode.replaceWith(frag);
	}
}

/**
 * Takes away every destination in the body, so nothing can navigate anywhere
 * by any means -- left click, middle click, long press, or "open in new tab",
 * none of which a click handler alone could stop. The words stay visible,
 * inert and de-emphasised.
 *
 * Every element and both spellings. It was `a` and `area`, `href` only, and
 * an SVG `<a xlink:href="...">` in a phishing message kept its destination:
 * measured, clicking it navigated the frame to the phishing address. What is
 * left in the spam folder after this is checked again once the frame's own
 * parse of it is known; see prepareFrame in messageFrame.ts.
 */
export function neutralizeLinks(doc: Document): void {
	for (const element of doc.querySelectorAll("[*|href]")) {
		element.removeAttribute("href");
		element.removeAttributeNS(XLINK, "href");
		element.removeAttribute("target");
		if (element instanceof HTMLElement) {
			element.style.color = "inherit";
			element.style.textDecoration = "none";
			element.style.cursor = "text";
			element.title = "";
		}
	}
}
