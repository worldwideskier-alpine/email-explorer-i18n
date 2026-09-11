import { i18n } from "@/i18n";

/**
 * Maps a raw API error message (as returned by the worker) to a localized
 * string via the `apiErrors` locale namespace. Falls back to the raw
 * message when there is no translation for it, since the worker API is
 * not locale-aware.
 */
export function translateApiError(
	message: string | undefined | null,
	fallback: string,
): string {
	const key = message || fallback;
	/*
	 * The namespace is fetched and indexed rather than asked for as
	 * `t("apiErrors." + key)`, because vue-i18n reads that argument as a
	 * dotted path and these keys are whole English sentences. "Registration
	 * is closed. Contact an administrator." was resolved as apiErrors ->
	 * "Registration is closed" -> " Contact an administrator" -> "", found
	 * nothing, and showed the raw English -- in all 73 languages, with the
	 * translation sitting in every catalogue the whole time. Indexing takes
	 * the key as the key, so a full stop in a message is just a full stop.
	 *
	 * `tm` falls back to the fallback locale when the current catalogue has
	 * no such namespace, which is what a language still being fetched looks
	 * like, and `rt` renders the entry the way `t` would have.
	 */
	const messages = i18n.global.tm("apiErrors") as Record<string, string>;
	const translated = messages[key];
	return translated === undefined ? key : i18n.global.rt(translated);
}
