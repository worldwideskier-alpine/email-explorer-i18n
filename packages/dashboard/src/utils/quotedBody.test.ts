import { describe, expect, it } from "vitest";
import { plainTextToParagraphs, toQuotableHtml } from "./quotedBody";

/**
 * The exact shape the worker stores a message that arrived with no HTML part
 * in: one `<pre>` around the sender's text, nothing else in the body.
 */
const asStored = (text: string) =>
	`<pre style="white-space: pre-wrap; font-family: inherit; margin: 0;">${text}</pre>`;

describe("a plain-text message being quoted", () => {
	/**
	 * The defect this exists for. tiptap's StarterKit parses any `<pre>` as a
	 * CodeBlock, so quoting a plain-text message put the whole letter into one
	 * atomic code node: it rendered as grey monospace source, it could not be
	 * split to answer point by point, and it went out to the recipient that
	 * way.
	 */
	it("does not hand a <pre> to the editor", () => {
		expect(
			toQuotableHtml(asStored("魚田　様\n\nお世話になります。")),
		).not.toContain("<pre");
	});

	it("becomes one paragraph per blank-line-separated block", () => {
		expect(
			toQuotableHtml(
				asStored("魚田　様\n\nお世話になります。\n供述書をお送りください。"),
			),
		).toBe(
			"<p>魚田　様</p><p>お世話になります。<br>供述書をお送りください。</p>",
		);
	});

	// Being several blocks rather than one is the whole point: it is what lets
	// a reply be written under each of the sender's paragraphs.
	it("gives the sender's paragraphs separate blocks to write between", () => {
		const html = toQuotableHtml(asStored("一つ目\n\n二つ目\n\n三つ目"));
		expect(html.match(/<p>/g)).toHaveLength(3);
	});

	it("keeps a run of spaces the sender lined a column up with", () => {
		expect(toQuotableHtml(asStored("商号    ビューティフルスノー"))).toBe(
			"<p>商号&nbsp;&nbsp;&nbsp;&nbsp;ビューティフルスノー</p>",
		);
	});

	it("keeps an indent of a single space", () => {
		expect(toQuotableHtml(asStored("一行目\n 長岡公証役場"))).toBe(
			"<p>一行目<br>&nbsp;長岡公証役場</p>",
		);
	});

	it("escapes markup in the quoted text", () => {
		expect(toQuotableHtml(asStored("a < b & c > d"))).toBe(
			"<p>a &lt; b &amp; c &gt; d</p>",
		);
	});

	// A sender's own quote markers are ordinary characters and stay as they
	// are; the reply's own quoting nests around them.
	it("leaves the sender's own > markers alone", () => {
		expect(toQuotableHtml(asStored("> 前のメッセージ"))).toBe(
			"<p>&gt; 前のメッセージ</p>",
		);
	});

	it("drops the leading and trailing blank lines a mailer adds", () => {
		expect(toQuotableHtml(asStored("\n\n本文です\n\n"))).toBe(
			"<p>本文です</p>",
		);
	});
});

describe("everything else is left as it is", () => {
	it("returns a real HTML message untouched", () => {
		const html = "<div><p>本文です</p><p>二段落目</p></div>";
		expect(toQuotableHtml(html)).toBe(html);
	});

	// Someone quoting an HTML message that genuinely contains code should
	// still see it as code.
	it("keeps a code block that is only part of a message", () => {
		const html =
			"<p>これを試してください</p><pre><code>npm run build</code></pre>";
		expect(toQuotableHtml(html)).toBe(html);
	});

	it("leaves a <pre> that has a sibling", () => {
		const html = "<pre>一行目</pre><p>あと</p>";
		expect(toQuotableHtml(html)).toBe(html);
	});

	it("returns an empty body as empty", () => {
		expect(toQuotableHtml("")).toBe("");
	});

	it("returns an empty <pre> as empty rather than a blank paragraph", () => {
		expect(toQuotableHtml(asStored(""))).toBe("");
	});
});

describe("plainTextToParagraphs", () => {
	it("normalises CRLF", () => {
		expect(plainTextToParagraphs("一行目\r\n二行目")).toBe(
			"<p>一行目<br>二行目</p>",
		);
	});

	it("treats three or more newlines as one paragraph break", () => {
		expect(plainTextToParagraphs("一つ目\n\n\n\n二つ目")).toBe(
			"<p>一つ目</p><p>二つ目</p>",
		);
	});
});
