import { createI18n } from "vue-i18n";
import de from "@/locales/de.json";
import en from "@/locales/en.json";
import ja from "@/locales/ja.json";

export type Locale = "ja" | "en" | "de";

const STORAGE_KEY = "email-explorer-locale";

function getInitialLocale(): Locale {
	const stored = localStorage.getItem(STORAGE_KEY);
	if (stored === "ja" || stored === "en" || stored === "de") {
		return stored;
	}
	return "ja";
}

export const i18n = createI18n({
	legacy: false,
	globalInjection: true,
	locale: getInitialLocale(),
	fallbackLocale: "en",
	messages: { en, ja, de },
});

export function setLocale(locale: Locale) {
	i18n.global.locale.value = locale;
	localStorage.setItem(STORAGE_KEY, locale);
	document.documentElement.setAttribute("lang", locale);
}

document.documentElement.setAttribute("lang", getInitialLocale());
