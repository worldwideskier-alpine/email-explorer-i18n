import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, h, nextTick } from "vue";
import { createI18n } from "vue-i18n";
import RichTextEditor from "./RichTextEditor.vue";

/**
 * A link in a message being written is text to edit, not a way out.
 *
 * StarterKit 3 brings its own Link and Underline, and the editor added its
 * own beside them: two `link` extensions, the kit's with openOnClick on.
 * Measured in Chromium, clicking the link in a quoted reply opened it in a
 * new tab. Tiptap says so as it starts ("Duplicate extension names"), which
 * is what this listens for; jsdom has no layout for a click to land on.
 */
describe("the editor's extensions", () => {
	const printed: string[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		printed.length = 0;
		document.body.innerHTML = "";
	});

	it("are each registered once", async () => {
		vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
			printed.push(args.map(String).join(" "));
		});
		const host = document.createElement("div");
		document.body.appendChild(host);
		const app = createApp({
			setup: () => () =>
				h(RichTextEditor, {
					modelValue: '<p><a href="https://example.org/">a link</a></p>',
				}),
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
		// The editor starts after mount; wait for it to have drawn the link.
		for (let i = 0; i < 20 && !host.querySelector(".ProseMirror a"); i++) {
			await new Promise((resolve) => setTimeout(resolve, 0));
			await nextTick();
		}

		expect(host.querySelector(".ProseMirror a")?.getAttribute("href")).toBe(
			"https://example.org/",
		);
		expect(printed.filter((line) => /Duplicate extension/.test(line))).toEqual(
			[],
		);
		app.unmount();
	});
});

/**
 * A quoted link keeps its destination and its words, and takes the class the
 * editor gives every link -- never the sender's, which this page's stylesheet
 * would obey (Claude Security F9).
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
	for (let i = 0; i < 20 && !host.querySelector(".ProseMirror a"); i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await nextTick();
	}
	return { host, app };
}

afterEach(() => {
	document.body.innerHTML = "";
});

describe("a link in the message being replied to", () => {
	it("takes the editor's class, not the sender's", async () => {
		const { host, app } = await drawn(
			'<p><a href="https://example.com/x" class="fixed inset-0 z-50 bg-white text-3xl">Session expired</a></p>',
		);
		const link = host.querySelector(".ProseMirror a") as HTMLAnchorElement;
		expect(link.getAttribute("href")).toBe("https://example.com/x");
		expect(link.textContent).toBe("Session expired");
		const classes = (link.getAttribute("class") ?? "").split(/\s+/);
		for (const sender of ["fixed", "inset-0", "z-50", "bg-white", "text-3xl"]) {
			expect(classes).not.toContain(sender);
		}
		expect(classes).toContain("text-blue-600");
		app.unmount();
	});

	it("goes out in the reply without it too", async () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		let sent = "";
		const app = createApp({
			setup: () => () =>
				h(RichTextEditor, {
					modelValue:
						'<p><a href="https://example.com/x" class="fixed inset-0">x</a></p>',
					"onUpdate:modelValue": (html: string) => {
						sent = html;
					},
				}),
		});
		app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} } }));
		app.mount(host);
		for (let i = 0; i < 20 && !host.querySelector(".ProseMirror a"); i++) {
			await new Promise((resolve) => setTimeout(resolve, 0));
			await nextTick();
		}
		const editorDom = host.querySelector(".ProseMirror") as unknown as {
			editor: { getHTML: () => string };
		};
		sent = sent || editorDom.editor.getHTML();
		expect(sent).toContain('href="https://example.com/x"');
		expect(sent).not.toMatch(/\bfixed\b|inset-0/);
		app.unmount();
	});
});
