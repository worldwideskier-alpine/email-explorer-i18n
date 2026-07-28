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
	if (i18n.global.te(`apiErrors.${key}`)) {
		return i18n.global.t(`apiErrors.${key}`);
	}
	return key;
}
