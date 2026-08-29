/**
 * Converts an email's HTML body to plain text.
 *
 * Used both when the composer is switched to plain-text mode and to build the
 * `text/plain` alternative part that goes out alongside every HTML message,
 * so anything wrong here is visible to recipients too.
 *
 * Stripping tags is not enough for real mail:
 *
 * - `<style>`, `<script>` and `<head>` hold text that must never be shown.
 *   Outlook puts a stylesheet in every message it sends, which is why a
 *   quoted reply used to begin with `P {margin-top:0;margin-bottom:0;}`.
 * - `<blockquote>` is the only thing marking which part is the quoted
 *   original. Dropping it runs the reply and the message being replied to
 *   together; plain text marks a quote with a `> ` prefix instead.
 * - Block elements have to become line breaks, and the runs of blank lines
 *   that produces have to be collapsed again, or a table-heavy message turns
 *   into pages of empty space.
 */

/** Elements whose text content is markup or metadata, never body copy. */
const DROPPED = new Set([
	"HEAD",
	"STYLE",
	"SCRIPT",
	"NOSCRIPT",
	"TITLE",
	"TEMPLATE",
	"META",
	"LINK",
]);

/** Elements a renderer would put on their own line. */
const BLOCK = new Set([
	"ADDRESS",
	"ARTICLE",
	"ASIDE",
	"BODY",
	"DD",
	"DIV",
	"DL",
	"DT",
	"FIELDSET",
	"FIGCAPTION",
	"FIGURE",
	"FOOTER",
	"FORM",
	"H1",
	"H2",
	"H3",
	"H4",
	"H5",
	"H6",
	"HEADER",
	"MAIN",
	"NAV",
	"OL",
	"P",
	"PRE",
	"SECTION",
	"TABLE",
	"TBODY",
	"TFOOT",
	"THEAD",
	"TR",
	"UL",
]);

/**
 * Normalises line endings, drops trailing whitespace and collapses runs of
 * blank lines. Applied to a quote's contents before the `> ` prefixes go on,
 * as well as to the finished text: once every blank line inside a quote is a
 * `>`, no later pass can tell it was blank.
 */
function collapseBlankLines(text: string): string {
	return text
		.replace(/\r\n?/g, "\n")
		.replace(/[^\S\n]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n");
}

function serialize(node: Node): string {
	if (node.nodeType === Node.TEXT_NODE) {
		// HTML collapses runs of whitespace, including the non-breaking spaces
		// Outlook is fond of, so the text has to be collapsed the same way --
		// otherwise every newline in the source becomes one in the output.
		return (node.textContent ?? "").replace(/\s+/g, " ");
	}
	if (node.nodeType !== Node.ELEMENT_NODE) return "";

	const el = node as Element;
	const tag = el.tagName.toUpperCase();
	if (DROPPED.has(tag)) return "";
	if (tag === "BR") return "\n";
	if (tag === "HR") return "\n----------------------------------------\n";

	let inner = "";
	for (const child of Array.from(el.childNodes)) inner += serialize(child);

	if (tag === "BLOCKQUOTE") {
		const quoted = collapseBlankLines(inner)
			.trim()
			.split("\n")
			// An empty quoted line is still quoted: a bare ">" keeps the block
			// contiguous for the receiving client, which stops quoting at the
			// first unprefixed line.
			.map((line) => (line.trim() ? `> ${line}` : ">"))
			.join("\n");
		return `\n${quoted}\n`;
	}
	if (tag === "LI") return `\n- ${inner.trim()}`;
	// Tab-separated, so a table's columns stay distinguishable in a monospace
	// reader without trying to reproduce the layout.
	if (tag === "TD" || tag === "TH") return `${inner.trim()}\t`;
	if (BLOCK.has(tag)) return `\n${inner}\n`;
	return inner;
}

export function htmlToPlainText(html: string): string {
	if (!html) return "";

	// Parsed as a whole document rather than assigned to an element's
	// innerHTML: the document DOMParser returns has no browsing context, so
	// nothing in the message can load a resource or run while we read it.
	const doc = new DOMParser().parseFromString(html, "text/html");

	return collapseBlankLines(serialize(doc.body)).replace(/^\n+|\s+$/g, "");
}

/** Escapes plain text back into HTML, preserving its line breaks. */
export function plainTextToSimpleHtml(text: string): string {
	const escaped = text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
	return escaped.replace(/\n/g, "<br>");
}
