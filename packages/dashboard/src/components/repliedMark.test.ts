import { afterEach, describe, expect, it } from "vitest";
import { createApp, nextTick } from "vue";
import { createI18n } from "vue-i18n";
import { englishWith } from "@/testing/english";
import RepliedMark from "./RepliedMark.vue";

/**
 * The sign on a message that has been answered from here: an arrow, with the
 * words and the time for whoever cannot see it, in the reader's language.
 */

const ja = Object.values(
	import.meta.glob("../locales/ja.json", { import: "default", eager: true }),
)[0] as Record<string, unknown>;

const sources = import.meta.glob(
	["../views/EmailList.vue", "../views/SearchResults.vue"],
	{ query: "?raw", import: "default", eager: true },
) as Record<string, string>;

let unmount = () => {};
afterEach(() => unmount());

function mount(at: string) {
	const i18n = createI18n({
		legacy: false,
		locale: "en",
		messages: { en: englishWith(), ja } as never,
	});
	const host = document.createElement("div");
	const app = createApp(RepliedMark, { at }).use(i18n);
	app.mount(host);
	unmount = () => app.unmount();
	return { host, i18n };
}

describe("the replied sign", () => {
	it("says it was answered, and when", () => {
		const { host } = mount("2026-10-01T07:13:00.000Z");
		const words = host.querySelector(".sr-only")?.textContent ?? "";
		expect(words).toMatch(/^Replied \(.*2026.*\)$/);
		expect(host.querySelector("[title]")?.getAttribute("title")).toBe(words);
		// The arrow itself is not read out on top of the words.
		expect(host.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
	});

	it("follows a change of language", async () => {
		const { host, i18n } = mount("2026-10-01T07:13:00.000Z");
		i18n.global.locale.value = "ja";
		await nextTick();
		expect(host.querySelector(".sr-only")?.textContent).toMatch(
			/^返信済み（.*）$/,
		);
	});

	it("is shown on the list and on search results, for an answered message only", () => {
		for (const [file, source] of Object.entries(sources)) {
			expect(source, file).toContain(
				'<RepliedMark v-if="email.replied_at" :at="email.replied_at" />',
			);
		}
	});
});
