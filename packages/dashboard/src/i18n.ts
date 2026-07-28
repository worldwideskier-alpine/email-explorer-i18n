import { createI18n } from "vue-i18n";
import en from "@/locales/en.json";
import ja from "@/locales/ja.json";

const STORAGE_KEY = "email-explorer-locale";

function getInitialLocale(): "ja" | "en" {
	const stored = localStorage.getItem(STORAGE_KEY);
	if (stored === "ja" || stored === "en") {
		return stored;
	}
	return "ja";
}

export const i18n = createI18n({
	legacy: false,
	globalInjection: true,
	locale: getInitialLocale(),
	fallbackLocale: "en",
	messages: { en, ja },
});

export function setLocale(locale: "ja" | "en") {
	i18n.global.locale.value = locale;
	localStorage.setItem(STORAGE_KEY, locale);
	document.documentElement.setAttribute("lang", locale);
}

document.documentElement.setAttribute("lang", getInitialLocale());
