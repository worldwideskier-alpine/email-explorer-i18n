import { describe, expect, it } from "vitest";
import { createApp, defineComponent, h, nextTick } from "vue";
import { createI18n } from "vue-i18n";
import { useDateFormat } from "./useDateFormat";

/**
 * Dates have to be written the way the reader's language writes them, and
 * have to change when the language does.
 *
 * Before this, all three views that show a message printed the stored value
 * straight out, so every row read `2026-08-30T18:46:35.184Z` in all 69
 * languages, and Admin.vue asked Intl for `en-US` by name.
 *
 * These assertions deliberately avoid pinning exact output: ICU changes the
 * separators and the spaces it uses between browser and Node versions, and a
 * test that pins them fails on an upgrade without anything being wrong. What
 * matters, and what is asserted, is that the output differs by language, is
 * not the ISO string, and follows a switch.
 */

const messages = { en: {}, ja: {}, de: {} };

function mount(render: (fns: ReturnType<typeof useDateFormat>) => unknown) {
	const i18n = createI18n({ legacy: false, locale: "en", messages });
	const host = document.createElement("div");
	document.body.appendChild(host);
	const app = createApp(
		defineComponent({
			setup() {
				const fns = useDateFormat();
				return () => h("p", String(render(fns)));
			},
		}),
	);
	app.use(i18n);
	app.mount(host);

	return {
		text: () => host.textContent ?? "",
		setLocale: async (locale: "en" | "ja" | "de") => {
			i18n.global.locale.value = locale;
			await nextTick();
		},
		unmount: () => {
			app.unmount();
			host.remove();
		},
	};
}

// Deliberately not "today", so formatListDate takes its date branch rather
// than its time branch and the test does not change meaning as the clock
// moves.
const OLD = "2026-03-09T18:46:35.184Z";

describe("useDateFormat", () => {
	it("does not put the stored ISO string on screen", () => {
		const view = mount(({ formatListDate }) => formatListDate(OLD));
		expect(view.text()).not.toContain("T18:46:35");
		expect(view.text()).not.toContain("Z");
		expect(view.text().length).toBeGreaterThan(0);
		view.unmount();
	});

	it("writes the same instant differently in different languages", async () => {
		const view = mount(({ formatFullDate }) => formatFullDate(OLD));

		const english = view.text();
		await view.setLocale("ja");
		const japanese = view.text();
		await view.setLocale("de");
		const german = view.text();

		expect(new Set([english, japanese, german]).size).toBe(3);
		view.unmount();
	});

	it("follows a language change while it is on screen", async () => {
		const view = mount(({ formatListDate }) => formatListDate(OLD));
		const before = view.text();
		await view.setLocale("ja");
		expect(view.text()).not.toBe(before);
		view.unmount();
	});

	// A list column is narrow. Today is a time; anything else is a date.
	it("shows a time for today and a date for anything older", () => {
		const now = new Date();
		const view = mount(({ formatListDate }) =>
			[formatListDate(now.toISOString()), "|", formatListDate(OLD)].join(""),
		);
		const [today, older] = view.text().split("|");

		expect(today).not.toContain(String(now.getFullYear()));
		expect(older).toContain(String(new Date(OLD).getFullYear()).slice(-2));
		view.unmount();
	});

	/**
	 * Whatever is in a broken field is evidence of what went wrong, and the
	 * date column is not the place to throw it away in favour of the word
	 * "Invalid Date".
	 */
	it("shows an unparseable value as it was stored", () => {
		for (const bad of ["not a date", ""]) {
			const view = mount(({ formatFullDate }) => formatFullDate(bad));
			expect(view.text()).toBe(bad);
			view.unmount();
		}
		for (const empty of [null, undefined]) {
			const view = mount(({ formatDay }) => formatDay(empty));
			expect(view.text()).toBe("");
			view.unmount();
		}
	});

	// Several registry codes are ones a browser may not carry data for. It
	// must fall back rather than throw and blank the whole list.
	it("survives a locale Intl does not know", async () => {
		const i18n = createI18n({
			legacy: false,
			locale: "yue",
			messages: { yue: {} },
		});
		const host = document.createElement("div");
		document.body.appendChild(host);
		const app = createApp(
			defineComponent({
				setup() {
					const { formatFullDate } = useDateFormat();
					return () => h("p", formatFullDate(OLD));
				},
			}),
		);
		app.use(i18n);
		expect(() => app.mount(host)).not.toThrow();
		expect(host.textContent).not.toContain("T18:46:35");
		app.unmount();
		host.remove();
	});
});
