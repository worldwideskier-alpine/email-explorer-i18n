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
 *
 * Each rule here is a FrameRule (frameRules.ts): one `find` that the rewrite
 * mends and the check of the frame's own reading asks to come back empty.
 */

import {
	ANIMATIONS,
	animatedAttributeOf,
	animationValuesOf,
	type FrameRule,
	removeDestination,
} from "./frameRules";

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
 * `<feImage>` is here on the same reading of the SVG spec; Chromium was
 * measured not fetching one, WebKit was not measured, and removing it costs a
 * spam message nothing.
 *
 * A selector, so the selector engine finds them rather than every element
 * with an `href` being asked its name. `feImage` keeps its capital: an HTML
 * document matches type selectors without regard to case only on HTML
 * elements, and this is an SVG one.
 */
const HREF_LOADS = "link[*|href], image[*|href], use[*|href], feImage[*|href]";

/**
 * SVG attributes whose value is CSS and may be `url(...)`: measured, `mask=`,
 * `filter=`, `clip-path=` and `cursor=` each fetched from the spam folder,
 * because only `style` was being read as CSS. A reference inside the message
 * itself -- `url(#gradient)` -- fetches nothing and stays.
 */
const URL_ATTRIBUTES = [
	"mask",
	"filter",
	"clip-path",
	"cursor",
	"fill",
	"stroke",
	"marker-start",
	"marker-mid",
	"marker-end",
];

/**
 * `url("...")`, `url('...')` and `url(...)` in any CSS this body carries, for
 * the rewrite -- and one left open at the end of the CSS, which a browser
 * closes for the sender. Measured: `style="background:url(https://...`, with
 * no `)`, fetched from the spam folder in all three spellings, when this
 * pattern was also what decided whether CSS fetched and it asked for the `)`.
 * FETCHES decides that now, and CSS the rewrite cannot mend is dropped
 * whole, so matching to the end is what keeps the rest of such a style rather
 * than what keeps the address out. A quoted address that is not closed falls
 * through to the last spelling, which runs to the next `)` or the end.
 */
const CSS_URL = /url\(\s*(?:"[^"]*"\s*\)|'[^']*'\s*\)|[^)]*(?:\)|$))/gi;

/**
 * Whatever in CSS fetches something -- one list, for the question of whether
 * it does: an `url(` that does not point into the message, `image-set(`, and
 * `@import`.
 *
 * `url(#gradient)` fetches nothing, and rewriting it took an SVG's own
 * gradient away. But which `url(` a browser sees depends on comments and
 * strings, and a pattern cannot read those: measured, `/*url(#*\/` in a
 * comment, `'url("#'` in a string and `url(#a;url(...)` in an animation's
 * list each hid a real address behind a match that began with `#`, and the
 * spam folder fetched it. So nothing is paired up. Every `url(` in the text
 * is looked at on its own, wherever it is, and CSS counts as fetching nothing
 * only if each one is followed by `#`. The one a browser reads is among them,
 * whichever it turns out to be.
 *
 * "Followed" skips only what CSS skips there: space, tab and the three line
 * breaks. `\s` skipped the no-break space and U+3000 as well, so
 * `url(&nbsp;#x)` passed as a reference into the message, while the browser
 * read a relative address and fetched it -- measured, from this application's
 * own origin, which is harmless only because the page's `base-uri 'self'`
 * keeps a message's `<base>` from pointing it anywhere else.
 */
const FETCHES = /url\((?![ \t\n\r\f]*["']?#)|image-set\(|@import/i;

/**
 * `image-set()`, which takes bare strings as well as `url()` -- so
 * `image-set("a.png" 1x)` has an address in it that the pass above would
 * never see. Matched whole, one level of nesting allowed, so a wrapped
 * `image-set(url(a.png) 1x)` goes with it rather than leaving a fragment.
 */
const CSS_IMAGE_SET =
	/(?:-webkit-)?image-set\((?:[^()]|\([^()]*(?:\)|$))*(?:\)|$)/gi;

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
 *
 * An `url()` that fetches nothing stays: a gradient or a clip beside a
 * tracker, or beside `url(http://...)` mentioned in a comment, survives,
 * where rewriting every address took them all away. Each match is judged by
 * cssFetches on its own text, escapes read, so a match that swallowed a
 * second `url(` goes -- and so does one whose second is spelled in escapes,
 * `/*url(#*\/background:u\rl(...)`.
 */
function stripCssFetches(css: string): string {
	return css
		.replace(CSS_IMPORT, "")
		.replace(CSS_IMAGE_SET, "none")
		.replace(CSS_URL, (match) => (cssFetches(match) ? "none" : match));
}

/**
 * CSS with its escapes read the way CSS reads them.
 *
 * `u\rl(` is the `url(` function to a browser, and so are `u\72 l(` and
 * `@\69mport` to theirs -- CSS lets any character of an identifier be written
 * as `\` and the character, or `\` and its code in hex. Measured: all four
 * spellings fetched from the spam folder, because the patterns above were
 * matched against the characters as written. This is CSS Syntax's "consume an
 * escaped code point", so the patterns can be matched against what the
 * browser will see.
 *
 * Written out rather than borrowed from the browser: Chromium's own CSS
 * parser does resolve these (measured, `u\rl(x)` comes back as `url("x")`),
 * but jsdom's does not -- it drops the declaration outright -- so a rule that
 * leaned on it would pass its tests for the wrong reason.
 */
export function decodeCssEscapes(css: string): string {
	return css.replace(
		/\\(?:([0-9a-fA-F]{1,6})(?:\r\n|[ \t\n\r\f])?|([\s\S]))/g,
		(_, hex: string | undefined, other: string | undefined) => {
			if (hex !== undefined) {
				const code = Number.parseInt(hex, 16);
				const invalid =
					code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff);
				return invalid ? "�" : String.fromCodePoint(code);
			}
			// A backslash before a newline continues a string and is not an
			// escape anywhere else; dropping it is the reading that finds more.
			return other === "\n" || other === "\r" || other === "\f"
				? ""
				: (other as string);
		},
	);
}

/** Whether CSS fetches anything, read as written or as a browser reads it. */
function cssFetches(css: string): boolean {
	if (FETCHES.test(css)) return true;
	return css.includes("\\") && FETCHES.test(decodeCssEscapes(css));
}

/**
 * CSS with nothing left in it that fetches, or null when there is no such
 * thing short of dropping it.
 *
 * The rewrite is taken only if cssFetches -- which pairs nothing up -- finds
 * nothing in the result, so the rewrite never has to be right about which
 * `url(` a browser will read. What it cannot mend is a fetch that exists only
 * once the escapes are read and lies outside every `url(` as written -- a
 * sender spelling `u\rl(` so that a filter will not see it -- and that CSS is
 * dropped whole rather than decoded and written back: decoding changes the
 * meaning of an escape that was there for a reason, such as a quote inside a
 * string.
 *
 * Why patterns and not a CSS tokenizer: nothing here has to read CSS the way
 * a browser does, only to find every place one might see an address -- and
 * that over-reads on purpose. Where the patterns and the browser disagree,
 * what it costs is a style taken away that fetched nothing (measured:
 * `url(#a\)...` drops the style it is in), not a fetch. A tokenizer would
 * keep more such styles, and would be a second reading of CSS that has to
 * match the browser's own, error recovery included, to be safe.
 */
function cssWithoutFetches(css: string): string | null {
	const rewritten = stripCssFetches(css);
	return cssFetches(rewritten) ? null : rewritten;
}

/**
 * The stylesheet a `<style>` makes: its own text, and not its descendants'.
 *
 * Inside `<svg>` the parser gives a `<style>` child elements, and a browser
 * builds the sheet from the style's direct text only -- measured, Chromium
 * read `.a{background:url(<g>#x) </g>https://...)}` as
 * `url("https://...")` and fetched it. `textContent` includes the `<g>`'s
 * text, so the check read `url(#x) https://...)` and let it through; and
 * `u<g>x</g>rl(` hid an `url(` from it altogether.
 */
function sheetOf(style: Element): string {
	return Array.from(style.childNodes)
		.filter((node): node is Text => node.nodeType === Node.TEXT_NODE)
		.map((node) => node.data)
		.join("");
}

const all = (doc: Document, selector: string) =>
	Array.from(doc.querySelectorAll(selector));

/**
 * Everything that makes displaying a message fetch something, one rule per
 * way of doing it. The order matters only for the first: an element removed
 * outright needs nothing else done to it.
 */
export const REMOTE_CONTENT_RULES: readonly FrameRule[] = [
	{
		// A stylesheet link is a fetch with nothing to show for it here, and a
		// meta refresh navigates the frame to an address of the sender's
		// choosing with no click -- which reports the open as well as a pixel.
		find: (doc) => all(doc, 'link, meta[http-equiv="refresh" i]'),
		fix: (element) => element.remove(),
	},
	{
		find: (doc) =>
			all(doc, FETCHING_ATTRIBUTES.map((name) => `[${name}]`).join(", ")),
		fix(element) {
			for (const name of FETCHING_ATTRIBUTES) element.removeAttribute(name);
		},
	},
	{
		// SVG predates `href` on these and still accepts `xlink:href`, which
		// removeAttribute("href") alone does not touch.
		find: (doc) => all(doc, HREF_LOADS),
		fix: removeDestination,
	},
	{
		find: (doc) =>
			all(doc, "[style]").filter((element) =>
				cssFetches(element.getAttribute("style") ?? ""),
			),
		fix(element) {
			const css = cssWithoutFetches(element.getAttribute("style") ?? "");
			if (css === null) element.removeAttribute("style");
			else element.setAttribute("style", css);
		},
	},
	{
		find: (doc) =>
			all(doc, "style").filter((element) => cssFetches(sheetOf(element))),
		fix(element) {
			// Written back as text alone, which takes the children with it.
			element.textContent = cssWithoutFetches(sheetOf(element)) ?? "";
		},
	},
	{
		find: (doc) =>
			all(doc, URL_ATTRIBUTES.map((name) => `[${name}]`).join(", ")).filter(
				(element) =>
					URL_ATTRIBUTES.some((name) =>
						cssFetches(element.getAttribute(name) ?? ""),
					),
			),
		fix(element) {
			for (const name of URL_ATTRIBUTES) {
				if (cssFetches(element.getAttribute(name) ?? "")) {
					element.removeAttribute(name);
				}
			}
		},
	},
	{
		// The same attributes, given a value by an animation after the markup
		// is read -- the way an SVG link was given its destination. Only one
		// that would give them an address: a fill fading from red to blue
		// fetches nothing, and was being taken away with the rest.
		find: (doc) =>
			all(doc, ANIMATIONS).filter(
				(element) =>
					URL_ATTRIBUTES.includes(animatedAttributeOf(element)) &&
					animationValuesOf(element).some(cssFetches),
			),
		fix: (element) => element.remove(),
	},
];

/*
 * A note on the second layer that isn't here.
 *
 * The obvious belt to put behind this is a policy of the frame's own --
 * `img-src 'none'` and the rest -- which would catch anything the rules above
 * have not heard of. Two ways of giving the frame one were measured in
 * Chromium 1194 against the same payloads (a plain image, an escaped CSS
 * `url()`, an SVG filter image), and neither held a single fetch back: a
 * `<meta http-equiv="Content-Security-Policy">` first in the `srcdoc`
 * document's head, and the iframe's own `csp` attribute. Both fetched exactly
 * what a frame with neither fetched. The frame has no response to attach a
 * header to, and it inherits the page's policy, which has to allow images
 * because the inbox displays them.
 *
 * The one arrangement that would carry a policy of its own is serving the
 * message from a Worker route with its own header -- which this application
 * cannot do as things stand, because its requests authenticate with a header
 * that a frame's `src` does not carry.
 *
 * So the rules above are not a belt, they are the whole thing, and they are
 * load-bearing. Anything that can name an address has to be added to them,
 * and the check of the frame's reading is what finds one added to the
 * rewrite and not the check -- they are the same rule now.
 */
