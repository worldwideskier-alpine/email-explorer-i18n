/**
 * The document a message is shown in, settled on the string before the frame
 * parses it, and checked against the frame's own reading of that string.
 *
 * The frame is a sandboxed `srcdoc` iframe with no scripts. Everything about
 * what it may do has to be decided here, in the markup, because the frame is
 * readable and tappable from its first paint -- a pass in its `load` handler
 * ran after every image had arrived, and a link was tapped before that.
 *
 * And "decided in the markup" means in the frame's reading of it, not in
 * whatever tree was edited. That is what the check at the end is for, and
 * what most of the rules here come from: each is a way the edited tree and
 * the frame's tree turned out to differ, measured in Chromium.
 */

import {
	EVERY_LINK_OPENS_A_TAB_OR_NOTHING,
	linkifyPlainUrls,
	NOTHING_HAS_A_DESTINATION,
} from "./emailLinks";
import { applyRules, type FrameRule, rulesHold } from "./frameRules";
import { REMOTE_CONTENT_RULES } from "./remoteContent";

/**
 * The document the frame parses, as one string.
 *
 * It lives here rather than in the component because it is also what
 * prepareFrame checks: a check of anything other than the exact string the
 * frame will be handed is a check of something else.
 *
 * The doctype changes nothing for the frame -- a `srcdoc` document is in
 * no-quirks mode with or without one, by rule. It changes the check: without
 * it DOMParser parsed in quirks mode (measured, `BackCompat`), which builds a
 * different tree around a `<table>` inside a `<p>`.
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

/**
 * Documents inside the document. Taken out whole.
 *
 * Measured: a message's own `<iframe srcdoc="...">` is a second document that
 * nothing here ever parsed -- the markup is one attribute's string -- and
 * `frame-src` does not refuse it, `about:srcdoc` being ours. It inherits this
 * frame's sandbox, `allow-popups-to-escape-sandbox` included, so in the spam
 * folder a `target="_blank"` link inside it opened the phishing page in an
 * ordinary tab, and an `<img>` inside it reported the open. Recursing into it
 * would mean a second copy of every rule here, for markup no mail program
 * shows anyway. `object` and `embed` are refused by `object-src 'none'`
 * already; they go on the same principle.
 */
const NESTED_DOCUMENTS =
	"iframe, frame, frameset, object, embed, fencedframe, portal";

/**
 * The attributes that turn a `<template>` into a live shadow root.
 *
 * Measured: `<template shadowrootmode="open">` is attached as a shadow root by
 * the frame's parser, whose contents are rendered and live -- a link in one
 * navigated the frame, and an image in one was fetched from the spam folder.
 * DOMParser does not attach it (declarative shadow DOM is for the parser that
 * builds a page, not for parseFromString), so every rule here and the check
 * were looking at an inert template while the frame showed a live one.
 * Without the attribute the frame's template is inert too, and the two
 * readings agree. `shadowroot` is the older spelling.
 */
const SHADOW_ROOT_ATTRIBUTES = ["shadowrootmode", "shadowroot"];

/**
 * What an SVG animation may not change.
 *
 * Measured: `<a><set attributeName="href" to="...">` gives an SVG link its
 * destination after the markup is read -- the attribute is absent, so no rule
 * saw a link at all, and the frame navigated when it was pressed. The same on
 * an `<image>` fetched a pixel in the spam folder. SMIL runs without scripts.
 * `target` is on the list because an animation could put back the `_self`
 * that the rule replaced -- that one is reasoned rather than measured.
 */
const ANIMATED_ATTRIBUTES_REFUSED = new Set(["href", "xlink:href", "target"]);

/**
 * The SVG animation elements, by the attribute that makes them one. Found by
 * the selector engine: walking every element of a large message and asking
 * each cost as much as a parse, three times over.
 */
const ANIMATIONS = "[attributeName]";

function animatesSomethingRefused(element: Element): boolean {
	const name = element.getAttribute("attributeName")?.trim();
	return name !== undefined && ANIMATED_ATTRIBUTES_REFUSED.has(name);
}

/** What no message needs and every other rule here would otherwise miss. */
const WHAT_BOTH_READINGS_CANNOT_SEE_ALIKE: readonly FrameRule[] = [
	{
		find: (doc) => Array.from(doc.querySelectorAll(NESTED_DOCUMENTS)),
		fix: (element) => element.remove(),
	},
	{
		find: (doc) =>
			Array.from(doc.querySelectorAll("template")).filter((template) =>
				SHADOW_ROOT_ATTRIBUTES.some((name) => template.hasAttribute(name)),
			),
		fix(template) {
			for (const name of SHADOW_ROOT_ATTRIBUTES) template.removeAttribute(name);
		},
	},
	{
		find: (doc) =>
			Array.from(doc.querySelectorAll(ANIMATIONS)).filter(
				animatesSomethingRefused,
			),
		fix: (element) => element.remove(),
	},
];

export interface FrameOptions {
	/** The spam folder: nothing may be pressed at all. */
	disableLinks?: boolean;
	/** The spam folder again: nothing may be fetched at all. */
	blockRemoteContent?: boolean;
}

/**
 * The rules a message is held to, in the order they are applied. Links come
 * last because linkifying, which runs just before them, adds links.
 */
function rulesFor(options: FrameOptions): {
	before: readonly FrameRule[];
	links: FrameRule;
} {
	return {
		before: [
			...WHAT_BOTH_READINGS_CANNOT_SEE_ALIKE,
			...(options.blockRemoteContent ? REMOTE_CONTENT_RULES : []),
		],
		links: options.disableLinks
			? NOTHING_HAS_A_DESTINATION
			: EVERY_LINK_OPENS_A_TAB_OR_NOTHING,
	};
}

const parse = (html: string) =>
	new DOMParser().parseFromString(html, "text/html");

const serialize = (doc: Document) =>
	`<!doctype html>${doc.documentElement.outerHTML}`;

/** Enough rounds for a mutation to settle; the ordinary case needs one. */
const ROUNDS = 3;

/**
 * The words of a message and nothing else, for the one case that needs it.
 *
 * Not `body.textContent` as it stands: a message's `<style>` and `<title>`
 * are parsed into the frame's body, so that read out the CSS rules and the
 * subject line as if they were the message -- measured, "件名.x{color:red}"
 * ahead of the text.
 */
function wordsOf(doc: Document): string {
	const body = doc.body.cloneNode(true) as HTMLElement;
	for (const element of Array.from(
		body.querySelectorAll("style, script, title, template"),
	)) {
		element.remove();
	}
	return (body.textContent ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

/**
 * The string the frame is handed.
 *
 * **Every rule is one definition, used twice.** Each is a FrameRule: the
 * rewrite mends what its `find` returns, and the check below asks the same
 * `find` of the frame's reading. The rewrite and the check used to be written
 * separately and kept in step by hand.
 *
 * **Parsed as the frame will parse it.** The body goes into the frame's
 * document and that whole document is parsed, so whatever the parser does
 * with a message's own `<html>`, `<head>` and `<body>` tags happens here as it
 * will there -- including merging the message's `<body>` attributes onto the
 * body it already has, which a parse of the body on its own threw away.
 *
 * **One parse for every rule.** Remote content is taken out on this same
 * document, where it used to be a separate parse ahead of this one. Besides
 * costing a parse, that one returned the head and body of its own document
 * and dropped the message's `<body>` attributes in the spam folder.
 *
 * **Checked by parsing the result again.** Parse, rewrite, serialise, parse is
 * two readings of the markup, and they can disagree -- one nested-`<form>`
 * shape turned a MathML `<a>` into a live HTML link on the second reading. So
 * the output is trusted when every rule holds on the frame's reading of it; if it
 * does not, the rules run on that reading and it is read again. That check
 * is not made conditional on how the markup looks: predicting which input
 * will read differently the second time is exactly what the tricks for it
 * are built to defeat.
 *
 * **And if it never settles, the words only**, which cannot be reparsed into
 * anything.
 *
 * Linkifying runs once, on the first reading, and is guarded: it is a
 * convenience, and a throw from it once took the whole message off the
 * screen. Once only, because on markup that reparses as text -- a URL inside
 * `<xmp>` -- the link it adds comes back as text with the URL still in it,
 * and running it again would never settle.
 */
export function prepareFrame(body: string, options: FrameOptions = {}): string {
	const { before, links } = rulesFor(options);
	const every = [...before, links];
	let html = frameDocument(body);
	for (let round = 0; round < ROUNDS; round++) {
		const doc = parse(html);
		if (round > 0 && rulesHold(doc, every)) return html;
		applyRules(doc, before);
		if (round === 0 && !options.disableLinks) {
			try {
				linkifyPlainUrls(doc);
			} catch (error) {
				console.error(`could not linkify the bare URLs in a message: ${error}`);
			}
		}
		applyRules(doc, [links]);
		html = serialize(doc);
	}
	const last = parse(html);
	if (rulesHold(last, every)) return html;

	console.warn("a message's markup did not settle; showing its text only");
	return frameDocument(
		`<pre style="white-space: pre-wrap">${wordsOf(last)}</pre>`,
	);
}
