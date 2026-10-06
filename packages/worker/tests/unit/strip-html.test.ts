import { describe, expect, it } from "vitest";
import {
	buildClassificationContent,
	stripHtml,
} from "../../src/claude-spam-filter";

/**
 * The words the spam check reads out of an HTML body.
 *
 * Read the way the HTML tokenizer reads markup, because a word read any other
 * way is one the classifier is not shown while the reader is. This was three
 * regular expressions, then a scan that gave their answers in linear time;
 * their answers took a visible `5 < 6`, `<scripts>` or `alt="<style>"` for
 * the start of something and dropped the words after it, so the scan now
 * reads as the tokenizer does. It runs inside the mailbox's Durable Object,
 * which answers nothing else meanwhile, on input the sender chooses, so it
 * still has to finish in time proportional to the message.
 */

describe("stripHtml", () => {
	it.each([
		["<p>Click <a href='x'>here</a></p>", "Click here"],
		["a<script>alert(1)</script>b", "a b"],
		["a<STYLE type=x>p{}</style>b", "a b"],
		["a<script>never closed", "a never closed"],
		["a < b and c > d", "a < b and c > d"],
		["x <> y", "x <> y"],
		["only < opening", "only < opening"],
		['<a title="<script>">x</script>', "x"],
		["a<!-- b -->c", "a c"],
		["a<!-- b > c -->d", "a c d"],
		["<!doctype html><p>a</p>", "a"],
		// A tag the message never ends: the browser shows nothing from its `<`.
		["<p>a</p><a href='x", "a"],
		["caf&eacute; &amp;lt; &nbsp;x", "caf&eacute; &lt; x"],
		// A title and a textarea hold text with references in it, as on
		// screen; xmp holds text as written.
		["<title>a&amp;b</title><textarea>c&lt;d</textarea>", "a&b c<d"],
		["<xmp>a&amp;b</xmp>", "a&amp;b"],
		["<p>a</p><plaintext>b&amp;c", "a b&amp;c"],
		// Control characters show as nothing or as space.
		["a\u0001b\u0090c", "a b c"],
	])("%j reads as %j", (html, words) => {
		expect(stripHtml(html)).toBe(words);
	});
});

/**
 * Each of these shows its marker in a browser -- parse5 with scripting off,
 * as in the message frame, measured -- and an earlier reading missed it: the
 * expressions this replaced, or a scan that took the first `</script>` for
 * a script's end. Five are inside svg, math and select, where the tree
 * builder, not the tokenizer, decides that a style is no style.
 */
describe("reads what a browser shows", () => {
	it.each([
		"<p>Orders under 5000 yen < ship today. SHOWN_AFTER_BARE_LT</p>",
		"<p>Hello << SHOWN_IN_BRACKETS >></p>",
		"<scripts>SHOWN_IN_SCRIPTS</scripts><p>Bye</p><script></script>",
		"<stylex>SHOWN_IN_STYLEX</stylex><style></style>",
		'<img alt="<style>">SHOWN_AFTER_ALT</p><b></style></b>',
		'<a title="><style>">SHOWN_AFTER_QUOTED_GT</a><style>p{}</style>',
		'<p class=a"b>SHOWN_AFTER_STRAY_QUOTE</p><p title="x">y</p>',
		"<!-- > <style> -->SHOWN_AFTER_COMMENT<style>p{}</style>",
		"<style>p{}</style >SHOWN_AFTER_SPACED_END<style>q{}</style>",
		"<noembed><style></noembed>SHOWN_AFTER_NOEMBED<style>p{}</style>",
		'<textarea><a title="</textarea>SHOWN_AFTER_TEXTAREA <p>x</p> ">',
		"<svg><style><p>SHOWN_AFTER_SVG_STYLE</p></style></svg>",
		"<svg a=b/><style><p>SHOWN_AFTER_UNQUOTED_SLASH</p></style></svg>",
		"<math></svg><style><b>SHOWN_AFTER_STRAY_SVG_END</b></style></math>",
		"<svg><text><![CDATA[SHOWN_IN_CDATA]]></text></svg>",
		"<select><option><style>SHOWN_IN_OPTION</style></option></select>",
		"<p>Hi</p><plaintext><style>SHOWN_IN_PLAINTEXT</style>",
		// A script that `<!--` and then `<script` have escaped ends at a later
		// `</script>` than the first: taken for the first, what followed was
		// read as markup, and a `<!--`, an open quote or a `<style>` in it
		// hid the words after the real end.
		"<script><!--<script></script><!--</script><p>SHOWN_AFTER_DOUBLY_ESCAPED</p><span hidden>--></span>",
		'<script><!--<script></script><a title="</script><p>SHOWN_AFTER_ESCAPED_END</p><p title=">x',
		"<script><!--<script></script><style></script><p>SHOWN_AFTER_ESCAPED_STYLE</p><style></style>",
		"<script><!--<script>x</script><!--</script>SHOWN_AFTER_ESCAPED_COMMENT<!-- -->",
		// The same inside math's `<mi>`, where an HTML script is an HTML
		// script, though math is counted open.
		'<math><mi><script><!--<script></script><a title="</script><p>SHOWN_AFTER_ESCAPED_IN_MI</p><p title=">x',
	])("%s", (html) => {
		const marker = /SHOWN_[A-Z_]+/.exec(html)?.[0] ?? "";
		expect(stripHtml(html)).toContain(marker);
	});
});

// The other side: what a browser does not show is not read.
describe("does not read what a browser hides", () => {
	it.each([
		"<p>shown</p><style>HIDDEN_CSS</style>",
		"<p>shown</p><script>HIDDEN_SCRIPT</script>",
		"<p>shown</p><!-- HIDDEN_COMMENT -->",
		"<p>shown</p><script><!--<script></script>HIDDEN_DOUBLY_ESCAPED</script>",
		'<p title="HIDDEN_ATTRIBUTE">shown</p>',
		"<!doctype HIDDEN_DOCTYPE><p>shown</p>",
		"<?HIDDEN_PI ?><p>shown</p>",
		'<p>shown</p><a href="HIDDEN_UNENDED',
		"<svg></svg><p>shown</p><style>HIDDEN_AFTER_SVG</style>",
		"<math/><p>shown</p><style>HIDDEN_AFTER_MATH</style>",
		"<p>shown</p><![CDATA[HIDDEN_CDATA]]>",
	])("%s", (html) => {
		const marker = /HIDDEN_[A-Z_]+/.exec(html)?.[0] ?? "";
		const words = stripHtml(html);
		expect(words).toContain("shown");
		expect(words).not.toContain(marker);
	});
});

/**
 * A comment's text after its first `>` is read, though no browser shows it:
 * the reading before this took `<!-- ... >` for a tag and read what followed,
 * and reading what the screen shows was not meant to take more of what it
 * hides out of the classifier's view. Read as markup of its own, so what is
 * in it goes no further than the comment -- the reading after it is the
 * browser's (`<!-- x > <style> -->` above).
 */
describe("reads a comment's far side, as it was read before", () => {
	it.each([
		"<p>shown</p><!-- a > READ_FAR_SIDE -->",
		"<!--[if mso]><table><tr><td>READ_FOR_OUTLOOK</td></tr></table><![endif]--><p>shown</p>",
	])("%s", (html) => {
		const marker = /READ_[A-Z_]+/.exec(html)?.[0] ?? "";
		const words = stripHtml(html);
		expect(words).toContain("shown");
		expect(words).toContain(marker);
		expect(words).not.toContain("<");
	});
});

/**
 * Pieces that show their word in a browser, and pieces that hide it, each
 * leaving the tokenizer as it found it -- so any sequence of them shows the
 * shown words and hides the hidden ones. Checked against parse5 one by one
 * and on these 20000 sequences of them, where the expressions this replaced
 * missed a third of the shown words. READ are hidden by a browser and read
 * here: a comment's far side, as above.
 */
const SHOWS: ((word: string) => string)[] = [
	(w) => ` ${w} `,
	(w) => ` 5 < ${w} `,
	(w) => ` <3 ${w} <= `,
	(w) => ` << ${w} >> `,
	(w) => ` <> ${w} `,
	(w) => `<p class=a"b>${w}</p>`,
	(w) => `<a 'x'>${w}</a>`,
	(w) => `<a title='x>y'>${w}</a>`,
	(w) => `<a title="><style>">${w}</a><style></style>`,
	(w) => `<img alt="<style>">${w}`,
	(w) => `<a title="<!--">${w}</a>`,
	(w) => `<scripts>${w}</scripts>`,
	(w) => `<stylex>${w}</stylex>`,
	(w) => `<!-- x > <style> -->${w}`,
	(w) => `<!-->${w}`,
	(w) => `<!--->${w}`,
	(w) => `<!-- x --!>${w}`,
	(w) => `<style>p{}</style >${w}`,
	(w) => `<style>p{}</STYLE/>${w}`,
	(w) => `<script>if (a<b) go()</script>${w}`,
	(w) => `<title><!--</title>${w}`,
	(w) => `<textarea><!--</textarea>${w}`,
	(w) => `<textarea>${w}</textarea>`,
	(w) => `<xmp><style></xmp>${w}`,
	(w) => `<noembed><style></noembed>${w}`,
	(w) => `<iframe><script></iframe>${w}`,
	(w) => `<noframes><!--</noframes>${w}`,
	(w) => `</>${w}`,
	(w) => `</ x>${w}`,
	(w) => `<?x ?>${w}`,
	(w) => `<!doctype html>${w}`,
	(w) => `<svg><style><p>${w}</p></style></svg>`,
	(w) => `<math></svg><style><b>${w}</b></style></math>`,
	(w) => `<svg a=b/><style><p>${w}</p></style></svg>`,
	(w) => `<svg><text><![CDATA[${w}]]></text></svg>`,
	(w) => `<select><option><style>${w}</style></option></select>`,
	// The tokenizer's script states: `<!--` escapes, `<script` (and only
	// that name) escapes doubly, `-->` goes back to plain script data -- the
	// dashes of `<!--` count -- and only there and escaped does `</script>`
	// end the element.
	(w) => `<script><!--<script></script><!--</script>${w}`,
	(w) => `<script><!--<script></script><a title="</script>${w}`,
	(w) => `<script><!--<script/></script><a title="</script>${w}`,
	(w) => `<script><!--<scripts></script>${w}--></script>`,
	(w) => `<script><!--<script>--><script></script>${w}</script>`,
	(w) => `<script><!--><script></script>${w}</script>`,
	(w) => `<script><!-- --></script>${w}`,
	(w) => `<SCRIPT><!--<ScRiPt\t></sCrIpT ><!--</script/>${w}`,
	(w) => `<!-- x > <a title=" -->${w}`,
];

const HIDES: ((word: string) => string)[] = [
	(w) => `<style>${w}</style>`,
	(w) => `<script>${w}</script>`,
	(w) => `<!-- ${w} -->`,
	(w) => `<script><!--<script></script>${w}</script>`,
	(w) => `<script><!--<script/></script>${w}--></script>`,
	(w) => `<a title="${w}">x</a>`,
	(w) => `<a title='${w} > '>x</a>`,
	(w) => `<!doctype ${w}>`,
	(w) => `<?${w}>`,
	(w) => `</x ${w}>`,
];

const READ: ((word: string) => string)[] = [
	(w) => `<!-- > ${w} -->`,
	(w) => `<!--[if mso]><b>${w}</b><![endif]-->`,
];

/** A small deterministic generator, so a failure names its own input. */
function generator(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

describe("on generated messages", () => {
	it("reads every word a browser shows and none it hides but a comment's far side, on 20000 of them", () => {
		const random = generator(99);
		for (let n = 0; n < 20000; n++) {
			const shown: string[] = [];
			const hidden: string[] = [];
			let html = "";
			const pieces = 1 + Math.floor(random() * 12);
			for (let k = 0; k < pieces; k++) {
				const which = random();
				if (which < 0.65) {
					shown.push(`SHOWN${k}X`);
					html += SHOWS[Math.floor(random() * SHOWS.length)](`SHOWN${k}X`);
				} else if (which < 0.9) {
					hidden.push(`HIDDEN${k}X`);
					html += HIDES[Math.floor(random() * HIDES.length)](`HIDDEN${k}X`);
				} else {
					shown.push(`READ${k}X`);
					html += READ[Math.floor(random() * READ.length)](`READ${k}X`);
				}
			}
			const words = stripHtml(html);
			for (const word of shown) expect(words, html).toContain(word);
			for (const word of hidden) expect(words, html).not.toContain(word);
		}
	});

	/**
	 * Told it has enough, the reading stops -- a 24MB message of references
	 * otherwise cost seconds of the Durable Object's time -- and what it has by
	 * then is exactly how the whole reading starts, so the classifier's 4000
	 * characters do not move.
	 */
	it("stops once it has enough, with what the whole reading starts with", () => {
		const random = generator(7);
		const pieces = [
			"&amp;",
			"&#x41;",
			"&shy",
			"&nbsp;x",
			" ",
			"word",
			"<b>",
			"</b>",
			"<!-- c -->",
			"<!-- > c &amp; -->",
			"<!-- ><b>c</b> &shy -->",
			"<script><!--<script></script>s</script>",
			"<style>s</style>",
			"<title>t &amp;</title>",
			"<xmp>&amp;</xmp>",
		];
		for (let n = 0; n < 5000; n++) {
			let html = "";
			const length = 1 + Math.floor(random() * 60);
			for (let k = 0; k < length; k++) {
				html += pieces[Math.floor(random() * pieces.length)];
			}
			const whole = stripHtml(html);
			const enough = Math.floor(random() * (whole.length + 2));
			const early = stripHtml(html, enough);
			expect(whole.startsWith(early), html).toBe(true);
			expect(early.length > enough || early === whole, html).toBe(true);
		}
		const long = `<p>${"word ".repeat(100_000)}</p>`;
		expect(stripHtml(long, 4000).length).toBeLessThan(4000 + 4096);
	});

	// The reading goes a step of 4096 characters at a time, and a step ends
	// where no reference can go on: wherever the step falls, a reference
	// across it is read whole.
	it("reads a reference whole wherever a step ends", () => {
		for (let offset = 4080; offset < 4100; offset++) {
			const words = stripHtml(`<p>${"x".repeat(offset)}&#x4F;&amp;Y</p>`);
			expect(words.slice(offset), String(offset)).toBe("O&Y");
		}
	});
});

describe("time", () => {
	it.each([
		["<style x", "unclosed style elements"],
		["<script>", "unclosed script elements"],
		["<a ", "tags that never close"],
		["<>", "empty brackets"],
		["<!---->", "comments, each closed"],
		["<!--x>", "comments inside a comment's far side"],
		["<!-- ><b> -->", "comments with markup on their far side"],
		["<script><!--</script>", "escaped scripts and a `-->` that never comes"],
		["<style></styles>", "style elements that never end"],
		['<a title="', "a quoted value that never ends"],
	])("takes linear time on 320KB of %j (%s)", (unit, _what) => {
		const html = unit.repeat(Math.ceil(320_000 / unit.length));
		const started = performance.now();
		stripHtml(html);
		// The expressions took 25 seconds on the first of these. Linear work
		// on 320KB is a few milliseconds; a second is room for a slow runner.
		expect(performance.now() - started).toBeLessThan(1000);
	});
});

describe("the classifier's content", () => {
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
