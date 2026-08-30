/**
 * Every language the dashboard ships, grouped the way the picker shows them.
 *
 * The target is the national and official languages of each region -- for
 * Europe the 24 official languages of the EU -- rather than a judgement about
 * which ones matter. A line someone can check is easier to maintain than a
 * list of favourites.
 *
 * This list is what the picker offers, so an entry goes in with its catalogue
 * and not before: offering a language that falls straight back to English is
 * worse than not offering it. messages.test.ts holds the two together.
 *
 * `label` is each language's own name for itself. A picker that names
 * languages in the language you are currently stuck in is no use to someone
 * who cannot read it.
 *
 * Catalogues are fetched on demand (see i18n.ts). At ~16KB each, loading all
 * of them up front would more than double what a first visit downloads.
 */

export type Region = "eastAsia" | "europe" | "southAsia" | "southeastAsia";

export interface LocaleEntry {
	code: string;
	label: string;
	region: Region;
	/** Only for scripts written right to left. */
	dir?: "rtl";
}

export const LOCALES = [
	{ code: "ja", label: "日本語", region: "eastAsia" },

	{ code: "bg", label: "Български", region: "europe" },
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
	{ code: "it", label: "Italiano", region: "europe" },
	{ code: "lt", label: "Lietuvių", region: "europe" },
	{ code: "lv", label: "Latviešu", region: "europe" },
	{ code: "mt", label: "Malti", region: "europe" },
	{ code: "nl", label: "Nederlands", region: "europe" },
	{ code: "pl", label: "Polski", region: "europe" },
	{ code: "pt", label: "Português", region: "europe" },
	{ code: "ro", label: "Română", region: "europe" },
	{ code: "sk", label: "Slovenčina", region: "europe" },
	{ code: "sl", label: "Slovenščina", region: "europe" },
	{ code: "sv", label: "Svenska", region: "europe" },

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

export function localesByRegion(): {
	region: Region;
	locales: LocaleEntry[];
}[] {
	return REGION_ORDER.map((region) => ({
		region,
		locales: LOCALES.filter((entry) => entry.region === region),
	})).filter((group) => group.locales.length > 0);
}
