/**
 * Converts a plain-text email body into HTML for storage/rendering. Emails
 * without an HTML part are stored as their raw postal-mime `text` value,
 * which is then injected directly into the dashboard's HTML-rendering
 * iframe (see EmailIframe.vue) - without this, HTML collapses newlines and
 * repeated whitespace, and unescaped `<`/`&` characters can be misread as
 * markup.
 */
export function plainTextToHtml(text: string): string {
	const escaped = text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
	return `<pre style="white-space: pre-wrap; font-family: inherit; margin: 0;">${escaped}</pre>`;
}
