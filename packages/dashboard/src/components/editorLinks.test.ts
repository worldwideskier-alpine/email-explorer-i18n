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
