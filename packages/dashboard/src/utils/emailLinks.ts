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
function leavesTheApp(element: HTMLAnchorElement | HTMLAreaElement): boolean {
	const written = element.getAttribute("href")?.trim() ?? "";
	if (!written || written.startsWith("#")) return false;
	// The resolved form, not the written one: a relative href in a message
	// resolves against this application's own address, and opening *that* in
	// the frame would put the app inside itself.
	return /^https?:\/\//i.test(element.href);
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
	const links = doc.body.querySelectorAll<HTMLAnchorElement | HTMLAreaElement>(
		"a[href], area[href]",
	);
	for (const link of links) {
		if (!leavesTheApp(link)) continue;
		link.target = "_blank";
		link.rel = "noopener noreferrer";
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
 * Strips every real `<a>` tag's href (and target) so it can't navigate
 * anywhere by any means -- left-click, middle-click, or "open in new tab"
 * from the context menu, none of which a JS click handler alone can stop.
 * The link text stays visible, just inert and visually de-emphasized.
 */
export function neutralizeLinks(doc: Document): void {
	if (!doc.body) return;
	for (const element of doc.body.querySelectorAll("a, area")) {
		element.removeAttribute("href");
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
 * The whole of it, on the string the frame will be handed.
 *
 * One parse, because there is no reason to do three. The order is the order
 * it has to be: bare URLs become links first, then every link in the body --
 * the sender's and the ones just made -- is told where to open.
 *
 * `disable` is the spam folder, where the requirement is the opposite one and
 * the timing matters just as much: while this waited for the frame's `load`,
 * a phishing message's links were live and tappable for as long as its images
 * took to arrive, which is the one message where that is least acceptable.
 *
 * Head and body are both returned for the reason stripRemoteContent gives:
 * a message's `<style>` is parsed into the head and belongs to how it looks.
 */
export function prepareLinks(
	html: string,
	{ disable = false }: { disable?: boolean } = {},
): string {
	const doc = new DOMParser().parseFromString(html, "text/html");
	if (disable) {
		neutralizeLinks(doc);
	} else {
		linkifyPlainUrls(doc);
		sendLinksToANewTab(doc);
	}
	return `${doc.head.innerHTML}${doc.body.innerHTML}`;
}
