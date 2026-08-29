import { describe, expect, it } from "vitest";
import { htmlToPlainText, plainTextToSimpleHtml } from "./htmlToPlainText";

describe("markup that must not become text", () => {
	// Outlook puts a stylesheet in every message it sends, so a quoted reply
	// to one used to begin with "P {margin-top:0;margin-bottom:0;}".
	it("drops a <style> block", () => {
		const text = htmlToPlainText(
			`<html><head><style type="text/css">P {margin-top:0;margin-bottom:0;}</style></head><body><p>本文です</p></body></html>`,
		);
		expect(text).toBe("本文です");
	});

	it("drops <script>, <title> and <noscript>", () => {
		const text = htmlToPlainText(
			`<html><head><title>タイトル</title></head><body><script>alert(1)</script><noscript>no js</noscript><p>本文です</p></body></html>`,
		);
		expect(text).toBe("本文です");
	});

	it("keeps a style block that appears mid-body", () => {
		const text = htmlToPlainText(
			`<div><style>.a{color:red}</style><p>本文です</p></div>`,
		);
		expect(text).not.toContain("color:red");
		expect(text).toContain("本文です");
	});
});

describe("quoting", () => {
	it("marks a blockquote with > on every line", () => {
		const text = htmlToPlainText(`<blockquote>一行目<br>二行目</blockquote>`);
		expect(text).toBe("> 一行目\n> 二行目");
	});

	// A receiving client stops treating a block as quoted at the first line
	// without a prefix, so a blank line inside a quote has to carry one too.
	it("prefixes blank lines inside a quote as a bare >", () => {
		const text = htmlToPlainText(
			`<blockquote><p>一行目</p><p>二行目</p></blockquote>`,
		);
		expect(text).toBe("> 一行目\n>\n> 二行目");
	});

	it("nests prefixes for a quoted quote", () => {
		const text = htmlToPlainText(
			`<blockquote>外側<br><blockquote>内側</blockquote></blockquote>`,
		);
		expect(text).toBe("> 外側\n>\n> > 内側");
	});

	it("keeps the reply above the quote separate from it", () => {
		const text = htmlToPlainText(
			`<br>返信本文<br><blockquote>引用された元のメール</blockquote>`,
		);
		expect(text).toBe("返信本文\n\n> 引用された元のメール");
	});
});

describe("block structure", () => {
	it("turns <br> and block elements into line breaks", () => {
		expect(htmlToPlainText(`<p>一</p><p>二</p>`)).toBe("一\n\n二");
		expect(htmlToPlainText(`<div>一<br>二</div>`)).toBe("一\n二");
	});

	// Outlook writes an empty paragraph per blank line, and wraps everything
	// in nested divs; without collapsing, a short message became pages long.
	it("collapses runs of blank lines to one", () => {
		const text = htmlToPlainText(
			`<div><p>一</p><p>&nbsp;</p><p>&nbsp;</p><p>&nbsp;</p><p>二</p></div>`,
		);
		expect(text).toBe("一\n\n二");
	});

	it("separates table cells with tabs and rows with newlines", () => {
		const text = htmlToPlainText(
			`<table><tr><td>項目</td><td>金額</td></tr><tr><td>工事</td><td>250,000円</td></tr></table>`,
		);
		expect(text).toBe("項目\t金額\n\n工事\t250,000円");
	});

	it("bullets list items", () => {
		expect(htmlToPlainText(`<ul><li>一</li><li>二</li></ul>`)).toBe(
			"- 一\n- 二",
		);
	});

	it("renders <hr> as a rule on its own line", () => {
		expect(htmlToPlainText(`<p>一</p><hr><p>二</p>`)).toMatch(
			/^一\n\n-{10,}\n\n二$/,
		);
	});

	// A newline in the source is insignificant whitespace in HTML, so it must
	// not survive as a line break in the output.
	it("collapses the source's own whitespace the way a renderer would", () => {
		expect(htmlToPlainText("<p>一\n   二\t三</p>")).toBe("一 二 三");
	});

	it("decodes entities", () => {
		expect(htmlToPlainText("<p>a &amp; b &lt;c&gt;</p>")).toBe("a & b <c>");
	});

	it("trims leading and trailing blank lines", () => {
		expect(htmlToPlainText("<br><br><p>本文</p><br><br>")).toBe("本文");
	});

	it("returns an empty string for empty input", () => {
		expect(htmlToPlainText("")).toBe("");
		expect(htmlToPlainText("<div></div>")).toBe("");
	});
});

describe("a realistic Outlook message", () => {
	const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office">
<head><meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<style type="text/css">P {margin-top:0;margin-bottom:0;}</style></head>
<body><div class="WordSection1">
<p>サンプル商事株式会社</p>
<p>&nbsp;</p>
<p>山田&nbsp; 様</p>
<p>&nbsp;</p>
<p>いつもお世話になっております。</p>
</div></body></html>`;

	it("reads as the message did, with nothing from the markup", () => {
		expect(htmlToPlainText(`<blockquote>${html}</blockquote>`)).toBe(
			[
				"> サンプル商事株式会社",
				">",
				"> 山田 様",
				">",
				"> いつもお世話になっております。",
			].join("\n"),
		);
	});
});

describe("plainTextToSimpleHtml", () => {
	it("escapes markup and keeps line breaks", () => {
		expect(plainTextToSimpleHtml("a & b\n<script>")).toBe(
			"a &amp; b<br>&lt;script&gt;",
		);
	});

	it("leaves plain text alone", () => {
		expect(plainTextToSimpleHtml("本文です")).toBe("本文です");
	});
});
