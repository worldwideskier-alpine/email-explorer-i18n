import { afterEach, describe, expect, it } from "vitest";
import { createApp, nextTick } from "vue";
import { createI18n } from "vue-i18n";
import { englishWith } from "@/testing/english";
import SentOnMarks from "./SentOnMarks.vue";

/**
 * The signs on a message answered or forwarded from here: an arrow each way,
 * with the words and the time for whoever cannot see them, in the reader's
 * language.
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

function mount(props: {
	repliedAt?: string | null;
	forwardedAt?: string | null;
}) {
	const i18n = createI18n({
		legacy: false,
		locale: "en",
		messages: { en: englishWith(), ja } as never,
	});
	const host = document.createElement("div");
	const app = createApp(SentOnMarks, props).use(i18n);
	app.mount(host);
	unmount = () => app.unmount();
	return { host, i18n };
}

const words = (host: Element) =>
	[...host.querySelectorAll(".sr-only")].map((e) => e.textContent ?? "");

describe("the replied and forwarded signs", () => {
	it("say what happened, and when", () => {
		const { host } = mount({
			repliedAt: "2026-10-01T07:13:00.000Z",
			forwardedAt: "2026-10-02T07:13:00.000Z",
		});
		const said = words(host);
		expect(said).toHaveLength(2);
		expect(said[0]).toMatch(/^Replied \(.*2026.*\)$/);
		expect(said[1]).toMatch(/^Forwarded \(.*2026.*\)$/);
		// Each sign's tooltip is its own words.
		const titled = [...host.querySelectorAll("[title]")].map((e) =>
			e.getAttribute("title"),
		);
		expect(titled).toEqual(said);
		// The arrows themselves are not read out on top of the words.
		for (const svg of host.querySelectorAll("svg")) {
			expect(svg.getAttribute("aria-hidden")).toBe("true");
		}
	});

	it("show only what happened", () => {
		expect(
			words(mount({ repliedAt: "2026-10-01T07:13:00.000Z" }).host),
		).toEqual([expect.stringMatching(/^Replied/)]);
		expect(
			words(mount({ forwardedAt: "2026-10-01T07:13:00.000Z" }).host),
		).toEqual([expect.stringMatching(/^Forwarded/)]);
		const none = mount({ repliedAt: null, forwardedAt: null }).host;
		expect(none.querySelector("svg")).toBeNull();
	});

	it("follow a change of language", async () => {
		const { host, i18n } = mount({
			repliedAt: "2026-10-01T07:13:00.000Z",
			forwardedAt: "2026-10-01T08:13:00.000Z",
		});
		i18n.global.locale.value = "ja";
		await nextTick();
		expect(words(host)).toEqual([
			expect.stringMatching(/^返信済み（.*）$/),
			expect.stringMatching(/^転送済み（.*）$/),
		]);
	});

	it("are shown on the list and on search results", () => {
		for (const [file, source] of Object.entries(sources)) {
			expect(source, file).toContain(
				'<SentOnMarks :replied-at="email.replied_at" :forwarded-at="email.forwarded_at" />',
			);
		}
	});
});
