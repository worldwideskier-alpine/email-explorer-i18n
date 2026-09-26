import { describe, expect, it } from "vitest";
import { createApp, h, nextTick, ref } from "vue";
import { createI18n } from "vue-i18n";
import RichTextEditor from "./RichTextEditor.vue";

/**
 * The HTML source box keeps what is typed into it.
 *
 * Each keystroke reaches the editor, and the editor's own HTML used to come
 * straight back into the box: a lone `<` became `<p>&lt;</p>` and the caret
 * went to the end, so no tag could be typed a letter at a time. Mounted for
 * real, with the real editor.
 */
describe("the HTML source box", () => {
	it("is not rewritten by the editor while it is being typed into", async () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		const html = ref("<p>hello</p>");
		const app = createApp({
			setup: () => () =>
				h(RichTextEditor, {
					modelValue: html.value,
					"onUpdate:modelValue": (v: string) => {
						html.value = v;
					},
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
		await nextTick();

		(
			host.querySelector(
				'[title="richTextEditor.toggleSourceCode"]',
			) as HTMLButtonElement
		).click();
		await nextTick();
		const box = host.querySelector("textarea") as HTMLTextAreaElement;
		expect(box.value).toContain("hello");

		for (const typed of ["<", "<s", "<strong>x"]) {
			box.value = typed;
			box.dispatchEvent(new Event("input"));
			await nextTick();
			expect(box.value).toBe(typed);
		}
		app.unmount();
		host.remove();
	});
});
