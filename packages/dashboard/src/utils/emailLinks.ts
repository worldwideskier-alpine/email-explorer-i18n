/**
 * What becomes of the links in a message body once the frame has parsed it.
 *
 * These three passes used to live inside EmailIframe.vue, where nothing could
 * reach them: the component's tests read its source as text, and a pass that
 * rewrites a DOM cannot be checked by reading the words that describe it. The
 * fault that moved them out was invisible for exactly that reason -- the
 * source said links open in a new tab, and the screen said otherwise.
 *
 * What the screen said, measured in Chromium against a destination that sends
 * `X-Frame-Options: DENY`, which is most of them:
 *
 *   - A sender's own `<a href="...">` carries no target. Clicking it navigates
 *     *the frame*, the destination refuses to be framed, and the message is
 *     replaced by `chrome-error://chromewebdata/` -- a grey panel with a torn
 *     page on it where the mail used to be. This is what "the link breaks it"
 *     looked like.
 *   - A link that does open a new tab opened a *sandboxed* one: the frame's
 *     sandbox is inherited by anything it opens unless the frame is given
 *     `allow-popups-to-escape-sandbox`, so the destination loaded with no
 *     scripts and an opaque origin. The probe page reported "scripts did NOT
 *     run"; with the flag added it reported its real origin. A modern site
 *     opened that way is a second kind of broken.
 *
 * So both halves are needed and they are in two different places: the sandbox
 * flag is on the element in EmailIframe.vue, and the target is here.
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
const URL_PATTERN = String.raw`https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&()*+,;=%]+`;
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
