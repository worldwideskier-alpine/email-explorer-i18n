import { describe, expect, it } from "vitest";
import {
	buildClassificationContent,
	stripHtml,
} from "../../src/claude-spam-filter";

/**
 * The words the spam check reads out of an HTML body.
 *
 * This used to be three regular expressions, and two of them were quadratic
 * on input the sender chooses; it runs inside the mailbox's Durable Object,
 * which answers nothing else meanwhile. The scan that replaced them has to
 * give the same answer -- the classifier's input must not move -- and give it
 * in time proportional to the message.
 */

/** What stripHtml was, kept here as the definition of the right answer. */
function byExpressions(html: string): string {
	return html
		.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** A small deterministic generator, so a failure names its own input. */
function* generated(count: number): Generator<string> {
	const pieces = [
		"<",
		">",
		"/",
		" ",
		"\n",
		"a",
		"x",
		"é",
		"İ",
		"ſ",
		"<script",
		"<SCRIPT",
		"<Style",
		"<style",
		"</script>",
		"</STYLE>",
		"</style>",
		"</script",
		"<>",
		"<b>",
		"</b>",
		"<!--",
		"-->",
		'"',
	];
	let seed = 12345;
	const random = () => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return seed / 0x7fffffff;
	};
	for (let n = 0; n < count; n++) {
		const length = 1 + Math.floor(random() * 30);
		let s = "";
		for (let k = 0; k < length; k++) {
			s += pieces[Math.floor(random() * pieces.length)];
		}
		yield s;
	}
}

describe("stripHtml", () => {
	it.each([
		["<p>Click <a href='x'>here</a></p>", "Click here"],
		["a<script>alert(1)</script>b", "a b"],
		["a<STYLE type=x>p{}</style>b", "a b"],
		["a<script>never closed", "a never closed"],
		["a < b and c > d", "a d"],
		["x <> y", "x <> y"],
		["only < opening", "only < opening"],
		['<a title="<script>">x</script>', '<a title="'],
	])("%j reads as %j", (html, words) => {
		expect(stripHtml(html)).toBe(words);
		expect(byExpressions(html)).toBe(words);
	});

	it("agrees with the expressions it replaced on 20000 generated inputs", () => {
		for (const html of generated(20000)) {
			expect(stripHtml(html), JSON.stringify(html)).toBe(byExpressions(html));
		}
	});

	it.each([
		["<style x", "unclosed style elements"],
		["<script>", "unclosed script elements"],
		["<a ", "tags that never close"],
		["<>", "empty brackets"],
	])("takes linear time on 320KB of %j (%s)", (unit, _what) => {
		const html = unit.repeat(Math.ceil(320_000 / unit.length));
		const started = performance.now();
		stripHtml(html);
		// The expressions took 25 seconds on the first of these. Linear work
		// on 320KB is a few milliseconds; a second is room for a slow runner.
		expect(performance.now() - started).toBeLessThan(1000);
	});

	it("is what the classifier is given for an HTML-only message", () => {
		const content = buildClassificationContent({
			subject: "s",
			from: "a@example.org",
			html: "<p>Hello <b>there</b></p><style>p{}</style>",
		});
		expect(content).toContain("Hello there");
		expect(content).not.toContain("<b>");
		expect(content).not.toContain("p{}");
	});
});
