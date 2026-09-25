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

import {
	destinationOf,
	type FrameRule,
	MATHML,
	removeDestination,
} from "./frameRules";

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
const LINK_CANDIDATES = "a, area, [*|href]";

/**
 * An address as the URL parser will read it, not as `String.trim` would.
 *
 * The parser strips only C0 controls and the ASCII space from the ends, and
 * tabs and newlines from anywhere. `trim` strips far more -- the ideographic
 * space, the no-break space -- so `href="　"` read as empty here and as the
 * relative path `%E3%80%80` in the browser: no target was added, and
 * pressing it navigated the frame to this application's own address and took
 * the message away. Measured, and the same for `href=" #top"`.
 */
function asTheUrlParserReadsIt(written: string): string {
	// Every code point up to U+0020 is a C0 control or the space.
	let start = 0;
	let end = written.length;
	while (start < end && written.charCodeAt(start) <= 0x20) start++;
	while (end > start && written.charCodeAt(end - 1) <= 0x20) end--;
	return written.slice(start, end).replace(/[\t\n\r]/g, "");
}

/**
 * Any base will do for telling what scheme an address has, and a fixed one
 * keeps the answer from depending on the document it was asked in: `.href`
 * resolved against the application's own address in a browser, `about:blank`
 * in a document built without one, and whatever a `<base>` in the message
 * said in between.
 */
const ANY_BASE = "https://relative.invalid/";

const HTTP_PREFIX = /^https?:\/\//i;

/** The schemes that must never be given anywhere to run. */
const SCRIPT_SCHEMES = new Set(["javascript:", "vbscript:"]);

/**
 * What pressing a link with this destination must do: open a tab of its own,
 * or nothing.
 *
 * Nothing, for three kinds, and each was measured taking the message away:
 *
 *   - An empty href, or one that is only a `#fragment`. A `srcdoc` document
 *     resolves those against the page that holds it, not against itself, so
 *     `href="#"` -- common in marketing templates -- and `#section` both meant
 *     this application's own address, and pressing either navigated the frame
 *     there, where the page's `frame-ancestors 'none'` refused it. They were
 *     left alone here on the belief that they jump within the message; they
 *     cannot, with or without help -- rewritten to `about:srcdoc#section` the
 *     message stayed but did not move, because a frame with no scripts has no
 *     way to scroll itself to a fragment.
 *   - A script URL. The frame runs none, but a sender's own `target="_blank"`
 *     on one survived, and the only thing that stopped the unsandboxed tab
 *     from running it was the page's CSP ("Refused to run the JavaScript
 *     URL"). Nothing here should rest on one layer that is not its own.
 *   - An address the URL parser cannot read, which no browser follows.
 *
 * Everything else opens a tab. That was once "http and https", and
 * `about:blank`, `data:`, `ftp:` and `mailto:` all took the message away.
 */
export function linkOpens(destination: string): boolean {
	const read = asTheUrlParserReadsIt(destination);
	if (!read || read.startsWith("#")) return false;
	// Nearly every link in a message is spelled like this, and a string that
	// begins with it has that scheme whatever follows -- so the answer is
	// known without asking the URL parser, which was most of the cost of this
	// rule on a large message (measured, some 5 ms per pass over 900 links).
	if (HTTP_PREFIX.test(read)) return true;
	try {
		return !SCRIPT_SCHEMES.has(new URL(read, ANY_BASE).protocol);
	} catch {
		return false;
	}
}

function linksIn(doc: Document): Element[] {
	return Array.from(doc.querySelectorAll(LINK_CANDIDATES)).filter(
		(element) => isLink(element) && destinationOf(element) !== null,
	);
}

const NO_WAY_BACK = "noopener noreferrer";

/**
 * Every link either opens a tab of its own or does nothing at all.
 *
 * The tab is an attribute rather than a click handler, which is what this
 * replaced. A handler can only answer a left click: a middle click, a long
 * press, "open in new tab" from the context menu and a keyboard activation
 * all go around it -- and `window.open` from a handler is a popup, which a
 * browser may refuse, at which point the handler has already cancelled the
 * navigation and the link does nothing at all. `target="_blank"` is the
 * browser's own path, is not popup-blocked, and holds for every one of those
 * ways of pressing it.
 *
 * `rel` asks for what `window.open(..., "noopener, noreferrer")` did: no
 * handle back to this window, and no Referer. It is part of what is checked,
 * not only what is written: a sender's own `target="_blank" rel="opener"` was
 * left as it came, because only the target was asked about, and the tab it
 * opened had `window.opener`. Nothing could be done with it -- measured,
 * navigating the frame through it threw -- but that was the browser's doing,
 * not this rule's.
 *
 * "Nothing" takes the destination away and leaves the words.
 *
 * One rule, although it has two outcomes. It was two for a round, so that
 * `fix` would not ask linkOpens again, and measured that way the whole frame
 * took about 7% longer on a message of 900 links: the second rule found every
 * link over again, on every pass and every check. Asking linkOpens again
 * costs only for the links that were found, and nearly all of them take the
 * `https://` shortcut.
 */
export const EVERY_LINK_OPENS_A_TAB_OR_NOTHING: FrameRule = {
	find: (doc) =>
		linksIn(doc).filter(
			(element) =>
				!linkOpens(destinationOf(element) as string) ||
				element.getAttribute("target") !== "_blank" ||
				element.getAttribute("rel") !== NO_WAY_BACK,
		),
	fix(element) {
		if (linkOpens(destinationOf(element) as string)) {
			// setAttribute rather than `.target =`: on an SVG `<a>` that
			// property is a read-only SVGAnimatedString and assigning throws.
			element.setAttribute("target", "_blank");
			element.setAttribute("rel", NO_WAY_BACK);
		} else {
			removeDestination(element);
			element.removeAttribute("target");
		}
	},
};

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

/**
 * Where a URL is left as text. Inside a link it is one already. The rest hold
 * text that the parser never reads as markup, so an `<a>` added inside one is
 * serialised as a tag and comes back from the frame's parse as the literal
 * characters `<a href=...>` -- measured, in a `<textarea>`, as
 * `see <a href="https://example.com/x" target="_blank" ...>` on screen.
 *
 * `iframe` is here for linkify on its own. In a message it never gets that
 * far: nested documents are removed before linkify runs (messageFrame.ts).
 */
const NOT_LINKIFIED =
	"a, script, style, textarea, title, xmp, iframe, noembed, noframes, plaintext";

/** Built once; without the `g` flag `test` keeps no state between calls. */
const HAS_URL = new RegExp(URL_PATTERN);

/**
 * Plain-text emails are stored as an escaped `<pre>` block (see
 * plain-text-to-html.ts) with bare URLs as plain text, and even genuine
 * HTML emails sometimes include a bare URL outside any `<a>`. Walk text
 * nodes (skipping ones already inside a link, and ones whose container the
 * parser reads as text; see NOT_LINKIFIED) and wrap
 * URL-looking substrings in real `<a>` elements so they're clickable.
 *
 * Where they open is not decided here. It used to be -- this set `target` on
 * the links it made -- and that left the sender's own links as the only ones
 * without it, which is precisely the set that broke. One pass decides that
 * now, for every link in the body (EVERY_LINK_OPENS_A_TAB_OR_NOTHING), and it
 * runs after this one.
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
			return !parent || parent.closest(NOT_LINKIFIED)
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
 * The spam folder's rule: nothing has a destination at all, so nothing can
 * navigate anywhere by any means -- left click, middle click, long press, or
 * "open in new tab", none of which a click handler alone could stop. The
 * words stay visible, inert and de-emphasised.
 *
 * Every element and both spellings. It was `a` and `area`, `href` only, and
 * an SVG `<a xlink:href="...">` in a phishing message kept its destination:
 * measured, clicking it navigated the frame to the phishing address.
 */
export const NOTHING_HAS_A_DESTINATION: FrameRule = {
	find: (doc) => Array.from(doc.querySelectorAll("[*|href]")),
	fix(element) {
		removeDestination(element);
		element.removeAttribute("target");
		if (element instanceof HTMLElement) {
			element.style.color = "inherit";
			element.style.textDecoration = "none";
			element.style.cursor = "text";
			element.title = "";
		}
	},
};
