/**
 * Prepares a stored message body for being quoted inside the reply composer.
 *
 * A message that arrived with no HTML part is stored as its plain text wrapped
 * in a single `<pre style="white-space: pre-wrap">` (see the worker's
 * plainTextToHtml). That is the right shape for *displaying* the original --
 * it reproduces the sender's own line breaks exactly -- but handing it to the
 * rich-text editor is not: tiptap's StarterKit parses any `<pre>` as a
 * CodeBlock, so the whole message became one atomic code node. Three things
 * followed from that, all of them wrong:
 *
 *  - the quoted letter rendered as source code, in a grey monospace box;
 *  - it was a single indivisible node, so there was nowhere to put the cursor
 *    between the quoted lines. Answering a message point by point -- writing
 *    under each of the sender's paragraphs -- was impossible; everything had
 *    to go above or below the box;
 *  - it was sent that way, so the recipient got the quote as a code block too.
 *
 * So the `<pre>` is opened back out into ordinary prose here, at the point the
 * quote is built, rather than repaired further downstream. A blank line starts
 * a new paragraph, every other newline is a `<br>`, and runs of spaces are
 * held with non-breaking spaces so a sender's aligned columns survive. (A
 * full-width ideographic space is not collapsed by HTML, so Japanese alignment
 * needs no help.)
 *
 * Anything else is returned untouched. A real HTML message keeps its markup,
 * and a genuine code block inside one stays a code block.
 */

/** True only for the whole-body single `<pre>` that plainTextToHtml produces. */
function soleElement(doc: Document): Element | null {
	const meaningful = Array.from(doc.body.childNodes).filter(
		(node) =>
			node.nodeType !== Node.TEXT_NODE ||
			(node.textContent ?? "").trim() !== "",
	);
	if (meaningful.length !== 1) return null;
	const only = meaningful[0];
	return only.nodeType === Node.ELEMENT_NODE ? (only as Element) : null;
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

/**
 * The text without the newlines it starts and ends with, found by index. It
 * was `/^\n+|\n+$/g`, and `\n+$` is tried again from every newline in a run
 * that something else follows: quadratic, and a sender's few hundred thousand
 * blank lines froze the tab on reply or forward (Claude Security F5).
 */
function withoutOuterNewlines(text: string): string {
	let start = 0;
	let end = text.length;
	while (start < end && text[start] === "\n") start += 1;
	while (end > start && text[end - 1] === "\n") end -= 1;
	return text.slice(start, end);
}

/**
 * Plain text as paragraphs a rich-text editor can take apart: one `<p>` per
 * blank-line-separated block, `<br>` for the line breaks inside a block.
 */
export function plainTextToParagraphs(text: string): string {
	const body = withoutOuterNewlines(text.replace(/\r\n?/g, "\n"));
	if (!body) return "";

	return body
		.split(/\n{2,}/)
		.map((block) => {
			const html = escapeHtml(block)
				// HTML folds a run of spaces down to one, which loses the columns
				// a plain-text sender lined up by hand.
				.replace(/ {2,}/g, (run) => "&nbsp;".repeat(run.length))
				// The same fold eats a single leading space, i.e. an indent.
				.replace(/^ /gm, "&nbsp;")
				.replace(/\n/g, "<br>");
			return `<p>${html}</p>`;
		})
		.join("");
}

export function toQuotableHtml(html: string): string {
	if (!html) return "";

	// Parsed as a whole document rather than through an element's innerHTML:
	// the document DOMParser returns has no browsing context, so nothing in the
	// message can load a resource or run while we read it.
	const doc = new DOMParser().parseFromString(html, "text/html");
	const only = soleElement(doc);
	if (!only || only.tagName.toUpperCase() !== "PRE") return html;

	return plainTextToParagraphs(only.textContent ?? "");
}
