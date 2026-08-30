import { createI18n } from "vue-i18n";
import {
	isLocale,
	type Locale,
	localeEntry,
	resolveBrowserLocale,
} from "@/locales/registry";

export type { Locale };

const STORAGE_KEY = "email-explorer-locale";
const FALLBACK: Locale = "en";
const DEFAULT: Locale = "ja";

/**
 * Catalogues are fetched when a language is first shown, not bundled into the
 * first load. There are 69 of them at roughly 20KB each; importing them all
 * would put about 1.3MB of translations nobody is reading into every visit.
 */
const catalogues = import.meta.glob<{ default: Record<string, unknown> }>(
	"./locales/*.json",
);

/**
 * Which language to open in.
 *
 * A stored choice wins over everything: someone who picked a language has
 * decided, and no header overrules that. Only when there is none -- a first
 * visit, a cleared browser, a private window -- is the browser's own list
 * read, because on a first visit the alternative is showing Japanese to
 * someone who cannot read it, with a picker they have to find first.
 *
 * The detected language is deliberately not written to storage. Nobody has
 * chosen anything yet, so there is nothing to remember, and leaving it unset
 * means the page keeps following the browser until someone does choose.
 *
 * DEFAULT remains the answer when the browser asks for a language this
 * dashboard does not carry.
 */
function getInitialLocale(): Locale {
	// localStorage throws in some privacy modes, and a missing preference is
	// not worth failing to start over.
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (isLocale(stored)) return stored;
	} catch {
		/* fall through to what the browser asks for */
	}

	const asked =
		typeof navigator === "undefined"
			? null
			: resolveBrowserLocale(
					navigator.languages ?? [navigator.language].filter(Boolean),
				);
	return asked ?? DEFAULT;
}

export const i18n = createI18n({
	legacy: false,
	globalInjection: true,
	locale: getInitialLocale(),
	fallbackLocale: FALLBACK,
	// Filled in by loadLocale before the app mounts.
	messages: {},
});

async function loadLocale(locale: Locale): Promise<void> {
	if (i18n.global.availableLocales.includes(locale)) return;
	const loader = catalogues[`./locales/${locale}.json`];
	if (!loader) return;
	const catalogue = await loader();
	i18n.global.setLocaleMessage(locale, catalogue.default);
}

function applyDocumentLanguage(locale: Locale): void {
	const root = document.documentElement;
	root.setAttribute("lang", locale);
	// Right-to-left scripts need the direction on the document, not just a
	// font: without it the browser lays the paragraph out left to right and
	// puts the punctuation on the wrong end.
	root.setAttribute("dir", localeEntry(locale).dir ?? "ltr");
}

export async function setLocale(locale: Locale): Promise<void> {
	await loadLocale(locale);
	i18n.global.locale.value = locale;
	try {
		localStorage.setItem(STORAGE_KEY, locale);
	} catch {
		/* the choice just will not survive a reload */
	}
	applyDocumentLanguage(locale);
}

/**
 * Awaited before the app mounts, so the first paint is already translated.
 * The fallback comes too, otherwise a key missing from a catalogue would
 * render as its own dotted path.
 */
export async function initLocale(): Promise<void> {
	const initial = getInitialLocale();
	await Promise.all(
		initial === FALLBACK
			? [loadLocale(FALLBACK)]
			: [loadLocale(FALLBACK), loadLocale(initial)],
	);
	i18n.global.locale.value = initial;
	applyDocumentLanguage(initial);
}
