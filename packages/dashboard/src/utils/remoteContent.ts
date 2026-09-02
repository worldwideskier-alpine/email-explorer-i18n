/**
 * Takes everything out of a message body that would fetch something the
 * moment the body is displayed.
 *
 * The reason is a tracking pixel. A one-by-one transparent image at a URL
 * unique to the recipient tells the sender the exact minute the message was
 * opened, from which IP, in which client -- and for a spam or phishing run,
 * that is the whole point of sending it: an address that opens mail is a live
 * address, worth more to the next list than one that does not. Merely looking
 * at a message in the spam folder to decide whether it really is spam should
 * not be what confirms the address works.
 *
 * So this runs on the way *in*, on the string, before the iframe is given it.
 * Removing an `<img>` after the frame has loaded is too late by exactly the
 * thing that matters: the request has already gone out. Only what never
 * reaches the parser is never fetched.
 *
 * Nothing here is a defence against code -- the frame carries no
 * `allow-scripts` and the page's own policy forbids script anyway. This is
 * about the quiet outbound requests that displaying a document makes on its
 * author's behalf.
 *
 * And it is the only thing doing it: see the note at the foot of this file
 * for why the frame has no policy of its own to fall back on.
 */

/**
 * Attributes that name something to load, on whatever element carries them.
 *
 * `background` and `lowsrc` are older than CSS and still honoured; `srcset`
 * and `imagesrcset` each hold a whole list of candidates, any one of which is
 * enough to report the open.
 */
const FETCHING_ATTRIBUTES = [
	"src",
	"srcset",
	"imagesrcset",
	"poster",
	"background",
	"lowsrc",
	"data",
];

/**
 * Where `href` is a resource to load rather than somewhere to go.
 *
 * On `<a>` it is a destination and stays -- a reader may still want to see
 * where a link points, and links are dealt with separately. On a stylesheet
 * link, or on SVG's `<image>` and `<use>`, it is fetched on sight.
 */
const HREF_LOADS = new Set(["LINK", "IMAGE", "USE"]);

/** `url("...")`, `url('...')` and `url(...)` in any CSS this body carries. */
const CSS_URL = /url\(\s*(?:"[^"]*"|'[^']*'|[^)]*)\s*\)/gi;

/**
 * `image-set()`, which takes bare strings as well as `url()` -- so
 * `image-set("a.png" 1x)` has an address in it that the pass above would
 * never see. Matched whole, one level of nesting allowed, so a wrapped
 * `image-set(url(a.png) 1x)` goes with it rather than leaving a fragment.
 */
const CSS_IMAGE_SET = /(?:-webkit-)?image-set\((?:[^()]|\([^()]*\))*\)/gi;

/**
 * `@import`, which fetches a stylesheet without an `url()` around the address
 * -- `@import "https://..."` is legal on its own.
 */
const CSS_IMPORT = /@import[^;}]*;?/gi;

/**
 * Rewrites a CSS declaration block or stylesheet so nothing in it loads.
 *
 * Addresses become `none` rather than being deleted, which leaves valid CSS
 * saying the thing that was wanted here anyway: `background-image: none` is
 * exactly what a body with no background image should say. Deleting the value
 * outright would leave `background-image: ;`, which a browser drops as
 * malformed -- the same result by a less honest route.
 */
function stripCssFetches(css: string): string {
	return css
		.replace(CSS_IMPORT, "")
		.replace(CSS_IMAGE_SET, "none")
		.replace(CSS_URL, "none");
}

/**
 * The body with every automatic fetch removed, ready to be put in front of a
 * reader.
 *
 * Parsed as a whole document rather than through an element's innerHTML: the
 * document DOMParser returns has no browsing context, so building it loads
 * nothing, which is the one property this function cannot do without.
 *
 * The parser puts a leading `<style>` -- and mail is full of them, Outlook
 * puts one in every message it sends -- in `<head>`, so both halves are
 * serialised back out in the order they were written. Returning the body
 * alone would silently throw the message's stylesheet away and leave it
 * looking broken.
 */
export function stripRemoteContent(html: string): string {
	if (!html) return "";

	const doc = new DOMParser().parseFromString(html, "text/html");

	// A stylesheet link is a fetch with nothing to show for it here, and a
	// meta refresh navigates the frame to an address of the sender's choosing
	// with no click at all -- which reports the open just as well as a pixel.
	for (const el of Array.from(
		doc.querySelectorAll('link, meta[http-equiv="refresh" i]'),
	)) {
		el.remove();
	}

	for (const el of Array.from(doc.querySelectorAll("*"))) {
		for (const attribute of FETCHING_ATTRIBUTES) {
			el.removeAttribute(attribute);
		}
		if (HREF_LOADS.has(el.tagName.toUpperCase())) {
			el.removeAttribute("href");
			// SVG predates `href` on these elements and still accepts the
			// namespaced spelling, which removeAttribute("href") does not touch.
			el.removeAttributeNS("http://www.w3.org/1999/xlink", "href");
		}

		const style = el.getAttribute("style");
		if (style) el.setAttribute("style", stripCssFetches(style));
	}

	for (const el of Array.from(doc.querySelectorAll("style"))) {
		el.textContent = stripCssFetches(el.textContent ?? "");
	}

	return `${doc.head.innerHTML}${doc.body.innerHTML}`;
}

/*
 * A note on the second layer that isn't here.
 *
 * The obvious belt to put behind this is a Content-Security-Policy of the
 * frame's own -- `img-src 'none'` and the rest -- which would catch anything
 * the passes above have not heard of. It was written, and then it was
 * measured: a `<meta http-equiv="Content-Security-Policy">` inside a `srcdoc`
 * document is **not enforced**. The element parses and is there in the DOM,
 * and every image in the body is fetched anyway. Chromium 1194, checked both
 * in this app and on a bare page with nothing else on it.
 *
 * So it was taken out rather than left in place looking like protection. The
 * frame carries no header of its own -- it has no response to attach one to
 * -- and it inherits the page's policy, which has to allow images because the
 * inbox displays them.
 *
 * Which means the passes above are not a belt, they are the whole thing, and
 * they are load-bearing. Anything added to a message body that can name an
 * address has to be added to them too; nothing else will stop it.
 */
