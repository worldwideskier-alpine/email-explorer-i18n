/**
 * Every language the dashboard ships, grouped the way the picker shows them.
 *
 * The target is the national and official languages of each region -- for
 * Europe, those of its sovereign states, taking the Council of Europe's
 * membership as the map, which is why Armenian, Azerbaijani, Georgian and
 * Turkish are here -- rather than a judgement about which ones matter. A line
 * someone can check is easier to maintain than a list of favourites. Regional
 * languages below the state level (Basque, Welsh, Faroese and the rest) sit
 * outside that line; Romansh is inside it because it is a national language of
 * Switzerland, and Norwegian is carried as both written standards for the same
 * reason Chinese is carried as two, not because Norway is a special case.
 *
 * West Asia is drawn as the national and official languages of the region's
 * states that are *not* already in Europe above -- Council of Europe
 * membership puts Armenia, Azerbaijan, Georgia, Turkey and Cyprus there, and
 * moving them now would break the one line Europe is drawn on. What remains
 * is Arabic, Hebrew and Persian. Persian is here rather than in South Asia
 * because Iran belongs to this group by every reading except the UN's
 * statistical one, and South Asia here is the subcontinent.
 *
 * Kurdish is the arguable omission: it is an official language of Iraq
 * alongside Arabic, so the line above admits it. It is left out for now
 * because it was not in what was agreed, not because the principle excludes
 * it.
 *
 * This list is what the picker offers, so an entry goes in with its catalogue
 * and not before: offering a language that falls straight back to English is
 * worse than not offering it. messages.test.ts holds the two together.
 *
 * `label` is each language's own name for itself. A picker that names
 * languages in the language you are currently stuck in is no use to someone
 * who cannot read it.
 *
 * Chinese is carried as two written standards rather than one `zh`, because
 * the choice a reader needs to make is Simplified or Traditional, not a
 * country. Cantonese is separate again: it is an official spoken language of
 * Hong Kong and Macao, and written Cantonese is not just Traditional
 * characters with a different accent -- the vocabulary and grammar differ.
 *
 * Entries are sorted by code inside each region, which is also the order the
 * picker shows. Sorting by label would order East Asia by the shape of each
 * endonym, which is arbitrary to everyone.
 *
 * Catalogues are fetched on demand (see i18n.ts). At ~20KB each, loading all
 * of them up front would dwarf everything else a first visit downloads.
 */

export type Region =
	| "eastAsia"
	| "europe"
	| "westAsia"
	| "southAsia"
	| "southeastAsia";

export interface LocaleEntry {
	code: string;
	label: string;
	region: Region;
	/** Only for scripts written right to left. */
	dir?: "rtl";
}

export const LOCALES = [
	{ code: "ja", label: "日本語", region: "eastAsia" },
	{ code: "ko", label: "한국어", region: "eastAsia" },
	{ code: "mn", label: "Монгол", region: "eastAsia" },
	{ code: "yue", label: "廣東話", region: "eastAsia" },
	{ code: "zh-Hans", label: "简体中文", region: "eastAsia" },
	{ code: "zh-Hant", label: "繁體中文", region: "eastAsia" },

	{ code: "az", label: "Azərbaycan dili", region: "europe" },
	{ code: "be", label: "Беларуская", region: "europe" },
	{ code: "bg", label: "Български", region: "europe" },
	{ code: "bs", label: "Bosanski", region: "europe" },
	{ code: "ca", label: "Català", region: "europe" },
	{ code: "cnr", label: "Crnogorski", region: "europe" },
	{ code: "cs", label: "Čeština", region: "europe" },
	{ code: "da", label: "Dansk", region: "europe" },
	{ code: "de", label: "Deutsch", region: "europe" },
	{ code: "el", label: "Ελληνικά", region: "europe" },
	{ code: "en", label: "English", region: "europe" },
	{ code: "es", label: "Español", region: "europe" },
	{ code: "et", label: "Eesti", region: "europe" },
	{ code: "fi", label: "Suomi", region: "europe" },
	{ code: "fr", label: "Français", region: "europe" },
	{ code: "ga", label: "Gaeilge", region: "europe" },
	{ code: "hr", label: "Hrvatski", region: "europe" },
	{ code: "hu", label: "Magyar", region: "europe" },
	{ code: "hy", label: "Հայերեն", region: "europe" },
	{ code: "is", label: "Íslenska", region: "europe" },
	{ code: "it", label: "Italiano", region: "europe" },
	{ code: "ka", label: "ქართული", region: "europe" },
	{ code: "lb", label: "Lëtzebuergesch", region: "europe" },
	{ code: "lt", label: "Lietuvių", region: "europe" },
	{ code: "lv", label: "Latviešu", region: "europe" },
	{ code: "mk", label: "Македонски", region: "europe" },
	{ code: "mt", label: "Malti", region: "europe" },
	{ code: "nb", label: "Norsk bokmål", region: "europe" },
	{ code: "nl", label: "Nederlands", region: "europe" },
	{ code: "nn", label: "Norsk nynorsk", region: "europe" },
	{ code: "pl", label: "Polski", region: "europe" },
	{ code: "pt", label: "Português", region: "europe" },
	{ code: "rm", label: "Rumantsch", region: "europe" },
	{ code: "ro", label: "Română", region: "europe" },
	{ code: "ru", label: "Русский", region: "europe" },
	{ code: "sk", label: "Slovenčina", region: "europe" },
	{ code: "sl", label: "Slovenščina", region: "europe" },
	{ code: "sq", label: "Shqip", region: "europe" },
	{ code: "sr", label: "Српски", region: "europe" },
	{ code: "sv", label: "Svenska", region: "europe" },
	{ code: "tr", label: "Türkçe", region: "europe" },
	{ code: "uk", label: "Українська", region: "europe" },

	{ code: "ar", label: "العربية", region: "westAsia", dir: "rtl" },
	{ code: "fa", label: "فارسی", region: "westAsia", dir: "rtl" },
	{ code: "he", label: "עברית", region: "westAsia", dir: "rtl" },

	{ code: "bn", label: "বাংলা", region: "southAsia" },
	{ code: "gu", label: "ગુજરાતી", region: "southAsia" },
	{ code: "hi", label: "हिन्दी", region: "southAsia" },
	{ code: "kn", label: "ಕನ್ನಡ", region: "southAsia" },
	{ code: "ml", label: "മലയാളം", region: "southAsia" },
	{ code: "mr", label: "मराठी", region: "southAsia" },
	{ code: "ne", label: "नेपाली", region: "southAsia" },
	{ code: "or", label: "ଓଡ଼ିଆ", region: "southAsia" },
	{ code: "pa", label: "ਪੰਜਾਬੀ", region: "southAsia" },
	{ code: "si", label: "සිංහල", region: "southAsia" },
	{ code: "ta", label: "தமிழ்", region: "southAsia" },
	{ code: "te", label: "తెలుగు", region: "southAsia" },
	{ code: "ur", label: "اردو", region: "southAsia", dir: "rtl" },

	{ code: "fil", label: "Filipino", region: "southeastAsia" },
	{ code: "id", label: "Bahasa Indonesia", region: "southeastAsia" },
	{ code: "km", label: "ខ្មែរ", region: "southeastAsia" },
	{ code: "lo", label: "ລາວ", region: "southeastAsia" },
	{ code: "ms", label: "Bahasa Melayu", region: "southeastAsia" },
	{ code: "my", label: "မြန်မာ", region: "southeastAsia" },
	{ code: "th", label: "ไทย", region: "southeastAsia" },
	{ code: "vi", label: "Tiếng Việt", region: "southeastAsia" },
] as const satisfies readonly LocaleEntry[];

export type Locale = (typeof LOCALES)[number]["code"];

/** The order the picker lists regions in, starting where this fork started. */
export const REGION_ORDER: Region[] = [
	"eastAsia",
	"europe",
	"westAsia",
	"southAsia",
	"southeastAsia",
];

const BY_CODE = new Map<string, LocaleEntry>(
	LOCALES.map((entry) => [entry.code, entry]),
);

export function isLocale(value: unknown): value is Locale {
	return typeof value === "string" && BY_CODE.has(value);
}

export function localeEntry(code: Locale): LocaleEntry {
	return BY_CODE.get(code) as LocaleEntry;
}

/**
 * Tags a browser sends that do not simply lowercase into a code here.
 *
 * Chinese is the substantive one: the browser reports a place (`zh-CN`,
 * `zh-TW`) while this list carries a script, so the country has to be read as
 * the script that country writes. Everything else is an older or alternate
 * spelling still in circulation -- `no` for Norwegian before bokmål and
 * nynorsk were distinguished, `tl` for what is now `fil`, and `in`, which is
 * what Java called Indonesian and what some runtimes still emit.
 */
const ALIASES: Record<string, Locale> = {
	zh: "zh-Hans",
	"zh-cn": "zh-Hans",
	"zh-sg": "zh-Hans",
	"zh-my": "zh-Hans",
	"zh-hans": "zh-Hans",
	"zh-tw": "zh-Hant",
	"zh-hk": "zh-Hant",
	"zh-mo": "zh-Hant",
	"zh-hant": "zh-Hant",
	"zh-yue": "yue",
	no: "nb",
	tl: "fil",
	in: "id",
};

const BY_LOWER_CODE = new Map<string, Locale>(
	LOCALES.map((entry) => [entry.code.toLowerCase(), entry.code as Locale]),
);

/**
 * The best language this dashboard can offer for what a browser asks for, or
 * null when it can offer none of them.
 *
 * Used only when nobody has chosen a language yet. A stored choice always
 * wins: picking a language is a decision, and a browser's header must not
 * overrule one somebody made.
 *
 * `navigator.languages` is in preference order and carries regions
 * (`ja-JP`, `pt-BR`), so each candidate is tried whole first -- that is what
 * separates `zh-TW` from `zh-CN` -- then as its base language. Trying every
 * step for one candidate before moving to the next matters: someone whose
 * list is `["zh-TW", "en"]` must get Traditional Chinese, not English.
 */
export function resolveBrowserLocale(
	candidates: readonly string[] | undefined,
): Locale | null {
	for (const candidate of candidates ?? []) {
		if (typeof candidate !== "string") continue;
		const tag = candidate.trim().toLowerCase();
		if (!tag) continue;

		const whole = BY_LOWER_CODE.get(tag) ?? ALIASES[tag];
		if (whole) return whole;

		const base = tag.split("-")[0];
		const stripped = BY_LOWER_CODE.get(base) ?? ALIASES[base];
		if (stripped) return stripped;
	}
	return null;
}

export function localesByRegion(): {
	region: Region;
	locales: LocaleEntry[];
}[] {
	return REGION_ORDER.map((region) => ({
		region,
		locales: LOCALES.filter((entry) => entry.region === region),
	})).filter((group) => group.locales.length > 0);
}
