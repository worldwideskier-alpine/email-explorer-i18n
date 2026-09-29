import { TextStyle } from "@tiptap/extension-text-style";
import StarterKit from "@tiptap/starter-kit";
import { Editor } from "@tiptap/vue-3";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, h, nextTick } from "vue";
import { createI18n } from "vue-i18n";
import { ColourHighlight, cssColour, TextColour } from "@/utils/editorColours";
import RichTextEditor from "./RichTextEditor.vue";

/**
 * A colour in the message being replied to is a colour, and nothing more.
 *
 * A reply or a forward puts the original into the editor, which is this page
 * and not the sandboxed frame. Tiptap's highlight took `<mark data-color>` as
 * it was and wrote it into `style="background-color: …"`, so the sender chose
 * the rest of that style: an overlay across the whole dashboard, a picture
 * fetched the moment the reply opened, and all of it sent on in the reply.
 */

async function drawn(content: string) {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const app = createApp({
		setup: () => () => h(RichTextEditor, { modelValue: content }),
	});
	app.use(
		createI18n({
			legacy: false,
			locale: "en",
			messages: { en: {} },
			missingWarn: false,
			fallbackWarn: false,
		}),
	);
	app.mount(host);
	for (let i = 0; i < 20 && !host.querySelector(".ProseMirror p"); i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await nextTick();
	}
	return { host, app };
}

/** Every style the editor drew, as written. */
const styles = (host: Element) =>
	[...host.querySelectorAll(".ProseMirror [style]")].map(
		(element) => element.getAttribute("style") ?? "",
	);

/** What a style would do beyond giving a colour. */
const doesMore = (style: string) =>
	/url\(|position|inset|z-index|display|width|height|expression|;\s*[a-z-]+\s*:\s*(?!inherit)/i.test(
		// jsdom ends a style it wrote back with a `;`.
		style.replace(/;\s*color:\s*inherit\s*;?\s*$/i, "").replace(/;\s*$/, ""),
	);

afterEach(() => {
	document.body.innerHTML = "";
});

const HOSTILE = [
	"red; position: fixed; inset: 0; z-index: 99999",
	"red;background-image:url(https://t.example/p.png)",
	"url(https://t.example/p.png)",
	"red} body{display:none",
	"#ff0 !important; width: 100vw",
	"expression(alert(1))",
];

describe("a highlight's colour", () => {
	it("keeps the colours the editor itself offers", async () => {
		const { host, app } = await drawn(
			'<p><mark data-color="#FFFF00">a</mark> <mark style="background-color: rgb(173, 216, 230)">b</mark> <mark data-color="lightblue">c</mark></p>',
		);
		// jsdom writes a style back in its own spelling (rgb for hex).
		const written = styles(host);
		expect(written).toHaveLength(3);
		for (const style of written) {
			expect(style).toMatch(/^background-color: [^;]+; color: inherit;?$/);
		}
		expect(written[2]).toContain("lightblue");
		app.unmount();
	});

	for (const value of HOSTILE) {
		it(`is dropped when it is more than a colour: ${value}`, async () => {
			const escaped = value.replace(/"/g, "&quot;");
			const { host, app } = await drawn(
				`<p><mark data-color="${escaped}">x</mark><mark style="background-color: ${escaped}">y</mark></p>`,
			);
			expect(host.querySelector(".ProseMirror mark")).not.toBeNull();
			for (const style of styles(host)) expect(doesMore(style)).toBe(false);
			expect(host.innerHTML).not.toContain("t.example");
			app.unmount();
		});
	}
});

describe("a text colour", () => {
	it("keeps an ordinary one", async () => {
		const { host, app } = await drawn(
			'<p><span style="color: #FF0000">a</span></p>',
		);
		expect(styles(host)).toHaveLength(1);
		expect(styles(host)[0]).toMatch(/^color: [^;]+;?$/);
		app.unmount();
	});

	for (const value of HOSTILE) {
		it(`is dropped when it is more than a colour: ${value}`, async () => {
			const escaped = value.replace(/"/g, "&quot;");
			const { host, app } = await drawn(
				`<p><span style="color: ${escaped}">x</span></p>`,
			);
			for (const style of styles(host)) expect(doesMore(style)).toBe(false);
			expect(host.innerHTML).not.toContain("t.example");
			app.unmount();
		});
	}
});

/**
 * What reaches the marks without being parsed -- a command, or content set
 * as JSON -- is held to the same rule when it is written out.
 */
describe("a colour given to the editor directly", () => {
	it("is written out only if it is a colour", () => {
		const editor = new Editor({
			extensions: [
				StarterKit.configure({ link: false, underline: false }),
				TextStyle,
				TextColour,
				ColourHighlight,
			],
			content: "<p>x</p>",
		});
		editor.commands.selectAll();
		editor.commands.setHighlight({ color: HOSTILE[0] });
		editor.commands.setColor(HOSTILE[1]);
		const html = editor.getHTML();
		expect(html).not.toMatch(/position|url\(/);
		expect(html).toContain("<mark>x</mark>");

		editor.commands.selectAll();
		editor.commands.setHighlight({ color: "#FFFF00" });
		editor.commands.setColor("#FF0000");
		expect(editor.getHTML()).toMatch(
			/background-color: ?(#FFFF00|rgb\(255, 255, 0\))/,
		);
		expect(editor.getHTML()).toMatch(/color: ?(#FF0000|rgb\(255, 0, 0\))/);
		editor.destroy();
	});
});

/**
 * And a colour read from a message is not kept in the document either, where
 * the toolbar would show it as the colour in use and anything that writes the
 * document out without rendering it would find it.
 */
describe("a colour read from a message", () => {
	it("is not kept when it is more than a colour", () => {
		const editor = new Editor({
			extensions: [
				StarterKit.configure({ link: false, underline: false }),
				TextStyle,
				TextColour,
				ColourHighlight,
			],
			content: `<p><mark data-color="${HOSTILE[0]}">x</mark><span style="color: ${HOSTILE[2]}">y</span><mark data-color="#FFFF00">z</mark></p>`,
		});
		const colours = JSON.stringify(editor.getJSON())
			.match(/"color":("[^"]*"|null)/g)
			?.map((pair) => pair.slice('"color":'.length));
		expect(colours).toEqual(["null", "null", '"#FFFF00"']);
		editor.destroy();
	});
});

describe("cssColour", () => {
	it("takes the ways a colour is written, and nothing else", () => {
		for (const colour of [
			"#abc",
			"#AABBCCDD",
			"rgb(1 2 3 / 50%)",
			"hsla(120, 50%, 50%, .5)",
			"transparent",
		]) {
			expect(cssColour(colour)).toBe(colour);
		}
		for (const other of [
			...HOSTILE,
			"rgb(url(x))",
			"",
			"  ",
			"red blue",
			"#12",
			null,
			3,
		]) {
			expect(cssColour(other)).toBeNull();
		}
	});
});
