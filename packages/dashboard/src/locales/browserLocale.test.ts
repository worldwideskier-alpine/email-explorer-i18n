import { describe, expect, it } from "vitest";
import { isLocale, LOCALES, resolveBrowserLocale } from "./registry";

/**
 * What a first visit opens in, when nobody has chosen a language yet.
 *
 * The choice someone makes is stored and always wins; this only decides the
 * case where there is no stored choice. Getting it wrong is not harmless:
 * too eager and it overrules people, too timid and someone who cannot read
 * Japanese lands on a Japanese page and has to find the picker first.
 */

describe("resolveBrowserLocale", () => {
	it("takes an exact code", () => {
		expect(resolveBrowserLocale(["ja"])).toBe("ja");
		expect(resolveBrowserLocale(["ko"])).toBe("ko");
	});

	// Browsers send a region, this list carries a language.
	it("falls back to the base language of a regional tag", () => {
		expect(resolveBrowserLocale(["ja-JP"])).toBe("ja");
		expect(resolveBrowserLocale(["pt-BR"])).toBe("pt");
		expect(resolveBrowserLocale(["en-GB"])).toBe("en");
		expect(resolveBrowserLocale(["de-AT"])).toBe("de");
	});

	/**
	 * The substantive alias. A browser names a country; this list names a
	 * script. Taiwan and Hong Kong write Traditional, the mainland and
	 * Singapore write Simplified, and getting that backwards hands someone a
	 * page they can read only with effort.
	 */
	it("reads a Chinese-speaking country as the script it writes", () => {
		expect(resolveBrowserLocale(["zh-TW"])).toBe("zh-Hant");
		expect(resolveBrowserLocale(["zh-HK"])).toBe("zh-Hant");
		expect(resolveBrowserLocale(["zh-MO"])).toBe("zh-Hant");
		expect(resolveBrowserLocale(["zh-CN"])).toBe("zh-Hans");
		expect(resolveBrowserLocale(["zh-SG"])).toBe("zh-Hans");
		// Bare `zh` has to land somewhere; Simplified has the larger readership.
		expect(resolveBrowserLocale(["zh"])).toBe("zh-Hans");
		// And a script subtag, which some browsers send instead.
		expect(resolveBrowserLocale(["zh-Hant"])).toBe("zh-Hant");
		expect(resolveBrowserLocale(["zh-Hans-CN"])).toBe("zh-Hans");
	});

	it("knows the older spellings still in circulation", () => {
		expect(resolveBrowserLocale(["no"])).toBe("nb");
		expect(resolveBrowserLocale(["no-NO"])).toBe("nb");
		expect(resolveBrowserLocale(["tl"])).toBe("fil");
		expect(resolveBrowserLocale(["in"])).toBe("id");
		expect(resolveBrowserLocale(["zh-yue"])).toBe("yue");
	});

	/**
	 * Preference order is the whole point of the header. Someone whose list
	 * begins with Traditional Chinese must not be handed English because
	 * English happened to match on a simpler rule.
	 */
	it("honours the order the browser asked in", () => {
		expect(resolveBrowserLocale(["zh-TW", "en"])).toBe("zh-Hant");
		expect(resolveBrowserLocale(["ko-KR", "ja", "en"])).toBe("ko");
		// A language this dashboard does not carry is skipped, not fatal.
		expect(resolveBrowserLocale(["sw-KE", "am", "de-DE"])).toBe("de");
	});

	it("gives up rather than guessing", () => {
		expect(resolveBrowserLocale(["sw", "am", "zu"])).toBeNull();
		expect(resolveBrowserLocale([])).toBeNull();
		expect(resolveBrowserLocale(undefined)).toBeNull();
		expect(resolveBrowserLocale([""])).toBeNull();
	});

	it("is not upset by junk", () => {
		expect(resolveBrowserLocale(["", "  ", "-", "x-y-z"])).toBeNull();
		expect(resolveBrowserLocale([null as never, 42 as never, "ja"])).toBe("ja");
	});

	it("only ever answers with a language that has a catalogue", () => {
		const asked = ["ja-JP", "en-US", "zh-TW", "no", "tl", "pt-BR", "de-CH"];
		for (const tag of asked) {
			const resolved = resolveBrowserLocale([tag]);
			expect(resolved).not.toBeNull();
			expect(isLocale(resolved)).toBe(true);
		}
	});

	// Every code in the picker has to be reachable from the tag a browser
	// would send for it, or the language is offered but never detected.
	it("resolves every code this dashboard ships", () => {
		const unreachable = LOCALES.map((entry) => entry.code).filter(
			(code) => resolveBrowserLocale([code]) !== code,
		);
		expect(unreachable).toEqual([]);
	});
});
