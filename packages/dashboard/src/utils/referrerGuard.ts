/**
 * Keeps this page's referrer policy the page's own, whatever HTML it parses.
 *
 * The page is served with `Referrer-Policy: same-origin`, because a path here
 * names a mailbox: nothing that leaves for another site should carry it.
 *
 * Measured in Chromium: parsing `<meta name="referrer" content="unsafe-url">`
 * with DOMParser -- a document with no window of its own, which nothing is
 * supposed to escape -- changed the referrer policy of the page that did the
 * parsing, for as long as the page stayed open. So did
 * `document.implementation.createHTMLDocument`. Parsing inside a `<template>`
 * did not. Opening one message carrying that tag made every later request,
 * from the page and from every message frame created after it, send the
 * address of whatever message was open -- in the spam folder as well, where
 * nothing is meant to leave at all.
 *
 * The message frame's own copy of the tag is taken out by its rules
 * (messageFrame.ts). This is for the page: every parse, this application's
 * and the editor's alike, is followed by putting the page's own policy back,
 * which a `<meta>` inserted into the page's head does -- measured, the same
 * parse followed by that left requests with no referrer. It runs in the same
 * task as the parse, before anything the parsed markup is used for has had a
 * chance to fetch.
 */

const POLICY = "same-origin";

export function keepReferrerPolicy(): void {
	document.head.querySelector("meta[data-referrer-guard]")?.remove();
	const meta = document.createElement("meta");
	meta.name = "referrer";
	meta.content = POLICY;
	meta.setAttribute("data-referrer-guard", "");
	document.head.appendChild(meta);
}

let installed = false;

/** Wraps DOMParser once, so that every parse puts the policy back. */
export function guardReferrerPolicy(): void {
	if (installed) return;
	installed = true;
	const parse = DOMParser.prototype.parseFromString;
	DOMParser.prototype.parseFromString = function (
		this: DOMParser,
		...args: Parameters<DOMParser["parseFromString"]>
	) {
		const doc = parse.apply(this, args);
		keepReferrerPolicy();
		return doc;
	} as DOMParser["parseFromString"];
	keepReferrerPolicy();
}
