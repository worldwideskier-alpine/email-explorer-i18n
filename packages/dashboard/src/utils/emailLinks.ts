/**
 * What becomes of the links in a message body, decided before the frame ever
 * sees it.
 *
 * Three things had to be true, and the third is the one that took three
 * attempts. All measured in Chromium against a destination that sends
 * `X-Frame-Options: DENY`, with the application's own CSP on the page.
 *
 *   1. A sender's own `<a href="...">` carries no target, so a click navigates
 *      *the frame*. The message is then replaced by a browser error page --
 *      and the refusal is ours before it is the destination's: the page says
 *      `frame-src 'self' blob:` and a `srcdoc` frame inherits it, so Chromium
 *      answers "Refused to frame ... frame-src" for every external link
 *      whatever the destination does. That grey panel is what "press the link
 *      and it breaks" was.
 *
 *   2. A link that does open a new tab opened a *sandboxed* one: the frame's
 *      sandbox is inherited by anything it opens unless the frame carries
 *      `allow-popups-to-escape-sandbox`, so the destination loaded with no
 *      scripts and an opaque origin -- the probe page reported "scripts did
 *      NOT run", and with the flag it reported its real origin. That flag is
 *      on the element in EmailIframe.vue.
 *
 *   3. **It has to be true from the first paint.** This ran in the frame's
 *      `load` handler, and a frame does not fire `load` until every image in
 *      it has arrived. A marketing message carries twenty, one of them a
 *      tracking pixel on a host that may never answer at all. Measured: three
 *      seconds in, the text was on screen and tappable, the frame had not
 *      fired `load`, and the link still read `target=""`. Tapping it then
 *      produced exactly the reported grey panel -- on the build that was
 *      supposed to have fixed it.
 *
 * So none of this waits for a load any more. It happens on the string, on the
 * way in, which is the same reason stripRemoteContent gives for living where
 * it does: what the parser is handed is the only thing that is true before
 * the first tap.
 */

/**
 * Whether a click on this would leave the application, and so must not be
 * allowed to happen inside the frame.
 *
 * A bare `#section` is a jump within the message and stays where it is --
 * sending it to a new tab would open `about:srcdoc` in one, which is a blank
 * page. `mailto:` and `tel:` are handed to the operating system and leave the
 * frame's content alone. What is left is http and https, which is the whole
 * of the problem.
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
function destinationOf(element: Element): string | null {
	return element.getAttribute("href") ?? element.getAttributeNS(XLINK, "href");
}

/**
 * Any base will do for telling a relative address from an absolute one, and
 * using a fixed one keeps the answer from depending on the document it was
 * asked in. It was `.href`, which resolves against the document's base: the
 * application's own address in a browser, `about:blank` in a document built
 * without one, and whatever a `<base>` in the message says in between.
 */
const ANY_BASE = "https://relative.invalid/";

function leavesTheApp(element: Element): boolean {
	const written = destinationOf(element)?.trim() ?? "";
	if (!written || written.startsWith("#")) return false;
	try {
		// The URL parser, not a pattern, decides the scheme: it is the one
		// that strips the tabs and newlines out of `java\tscript:` before
		// the browser does, so it is the one that agrees with the browser.
		return /^https?:$/.test(new URL(written, ANY_BASE).protocol);
	} catch {
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
 * `<area>` is included because an image map is still a link, and Japanese
 * marketing mail is full of them.
 *
 * `rel` is set to what `window.open(..., "noopener,noreferrer")` was asking
 * for, so nothing about what the destination is told changes: no reference
 * back to this window, and no Referer header.
 */
export function sendLinksToANewTab(doc: Document): void {
	if (!doc.body) return;
	// Every element, not `a` and `area`: a MathML `<a>` with an href is not a
	// link where it stands, and becomes an HTML one when the frame parses
	// the markup again -- measured, through a nested-form construct. An
	// attribute set here survives that; a check against the element's kind
	// does not. On anything that is not a link, `target` does nothing.
	for (const element of doc.querySelectorAll("*")) {
		if (!leavesTheApp(element)) continue;
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
			const parent = (node as Text).parentElement;
			if (!parent || parent.closest("a, script, style")) {
				return NodeFilter.FILTER_REJECT;
			}
			return new RegExp(URL_PATTERN).test(node.textContent || "")
				? NodeFilter.FILTER_ACCEPT
				: NodeFilter.FILTER_REJECT;
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
 * parse of it is known; see prepareFrame.
 */
export function neutralizeLinks(doc: Document): void {
	if (!doc.body) return;
	for (const element of doc.querySelectorAll("*")) {
		if (destinationOf(element) === null) continue;
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

/**
 * The document the frame parses, as one string.
 *
 * It lives here rather than in the component because it is also what
 * prepareFrame checks: a check of anything other than the exact string the
 * frame will be handed is a check of something else.
 *
 * The doctype is new, and changes nothing for the frame -- measured, a
 * `srcdoc` document is in no-quirks mode with or without one, because the
 * spec says so for srcdoc. What it changes is the check. DOMParser applies no
 * such rule: without a doctype it parsed in quirks mode (measured,
 * `BackCompat`), which builds a different tree around a `<table>` inside a
 * `<p>`, so the tree that was inspected was not the tree that was shown.
 */
export function frameDocument(body: string): string {
	return `<!doctype html>
    <html>
      <head>
        <meta charset="utf-8">
        <style>
          body {
            background-color: #f8f8f8;
            color: #333;
            font-family: sans-serif;
            padding: 1rem;
          }
          a {
            color: #2563eb;
            text-decoration: underline;
          }
        </style>
      </head>
      <body>
        ${body}
      </body>
    </html>
  `;
}

const parse = (html: string) =>
	new DOMParser().parseFromString(html, "text/html");

const serialize = (doc: Document) =>
	`<!doctype html>${doc.documentElement.outerHTML}`;

/**
 * Whether the tree the frame will build is the one that was asked for: in
 * the spam folder, nothing with a destination at all; anywhere else, nothing
 * that leaves without saying where to open.
 */
function isSafe(doc: Document, disable: boolean): boolean {
	for (const element of doc.querySelectorAll("*")) {
		if (disable) {
			if (destinationOf(element) !== null) return false;
		} else if (
			leavesTheApp(element) &&
			element.getAttribute("target") !== "_blank"
		) {
			return false;
		}
	}
	return true;
}

/** Enough rounds for a mutation to settle; the ordinary case needs one. */
const ROUNDS = 3;

/**
 * The string the frame is handed: the body with every link decided, checked
 * against the frame's own reading of it.
 *
 * **Parsed as the frame will parse it.** The body goes into the frame's
 * document first and that whole document is parsed, so whatever the parser
 * does with a message's own `<html>`, `<head>` and `<body>` tags happens here
 * exactly as it will there. The previous version parsed the body on its own
 * and returned `head.innerHTML + body.innerHTML`, which threw away the
 * attributes on the message's `<body>` -- measured, a newsletter written as
 * `<body style="background:#000" bgcolor="#000000">` with white text came
 * out on this frame's light grey, unreadable, and `dir="rtl"` went with it.
 * In the frame the parser merges those attributes onto the body it already
 * has, and now that happens here too, and is serialised with it.
 *
 * **Checked by parsing the result again.** Parse, rewrite, serialise, parse
 * is two readings of the markup, and they can disagree: that is the whole
 * family of mutation tricks sanitisers are bypassed with. Measured against
 * the real pipeline with nine known shapes, one got through -- a
 * nested-`<form>` construct that leaves an `<a>` in the MathML namespace on
 * the first reading and makes it an HTML link on the second, where it had no
 * target and navigated the frame. So the output is not trusted because the
 * rewrite ran; it is trusted when the frame's reading of it passes. If it
 * does not, the rewrite runs on that reading and the result is read again.
 *
 * **And if it never settles, the words only.** A message whose markup keeps
 * changing under reparsing is not an ordinary message, and showing its text
 * without any markup cannot be reparsed into anything.
 *
 * Linkifying is guarded because it is a convenience and the rest is not. It
 * once ran unguarded ahead of everything else, and a throw from it -- one
 * engine's quirk is enough -- took the whole message off the screen:
 * measured, no frame at all, just a Vue render error.
 */
export function prepareFrame(
	body: string,
	{ disable = false }: { disable?: boolean } = {},
): string {
	let html = frameDocument(body);
	for (let round = 0; round < ROUNDS; round++) {
		const doc = parse(html);
		if (round > 0 && isSafe(doc, disable)) return html;
		if (round === 0 && !disable) {
			try {
				linkifyPlainUrls(doc);
			} catch (error) {
				console.error(`could not linkify the bare URLs in a message: ${error}`);
			}
		}
		if (disable) neutralizeLinks(doc);
		else sendLinksToANewTab(doc);
		html = serialize(doc);
	}
	const last = parse(html);
	if (isSafe(last, disable)) return html;

	console.warn("a message's markup did not settle; showing its text only");
	const words = (last.body?.textContent ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
	return frameDocument(`<pre style="white-space: pre-wrap">${words}</pre>`);
}
