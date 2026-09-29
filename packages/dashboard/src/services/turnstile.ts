/**
 * Cloudflare's Turnstile script, loaded once and only by a page that shows
 * the widget: a deployment that has not turned it on never asks another
 * origin for anything. `_headers` allows this one script and its frame.
 */

const SCRIPT =
	"https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

export interface TurnstileOptions {
	sitekey: string;
	callback: (token: string) => void;
	"expired-callback"?: () => void;
	"error-callback"?: (code: string) => boolean | undefined;
	theme?: "auto" | "light" | "dark";
	language?: string;
	size?: "normal" | "flexible" | "compact";
}

export interface TurnstileApi {
	render(container: HTMLElement, options: TurnstileOptions): string | undefined;
	reset(widgetId: string): void;
	remove(widgetId: string): void;
}

declare global {
	interface Window {
		turnstile?: TurnstileApi;
	}
}

/**
 * The languages Turnstile's widget speaks, as its own list gives them
 * (developers.cloudflare.com/turnstile/reference/supported-languages, copied
 * by the turnstile-types package).
 */
const SPOKEN = new Set([
	"ar",
	"bg",
	"cs",
	"da",
	"de",
	"el",
	"en",
	"es",
	"fa",
	"fi",
	"fr",
	"he",
	"hi",
	"hr",
	"hu",
	"id",
	"it",
	"ja",
	"ko",
	"lt",
	"ms",
	"nl",
	"no",
	"pl",
	"pt",
	"ro",
	"ru",
	"sk",
	"sl",
	"sr",
	"sv",
	"th",
	"tl",
	"tr",
	"uk",
	"vi",
	"zh-cn",
	"zh-tw",
]);

/** Ours by another name, where Turnstile names it differently. */
const CALLED = {
	"zh-Hans": "zh-cn",
	"zh-Hant": "zh-tw",
	yue: "zh-tw",
	nb: "no",
	nn: "no",
	fil: "tl",
} as Record<string, string>;

/**
 * The widget's language for the page's. Left to itself ("auto") it follows
 * the browser's own language, not the one picked on this page, so a page in
 * Japanese showed "Success!". A language Turnstile does not have goes back
 * to "auto", which is the nearest it can do.
 */
export function turnstileLanguage(locale: string): string {
	const called = CALLED[locale] ?? locale.toLowerCase();
	return SPOKEN.has(called) ? called : "auto";
}

let loading: Promise<TurnstileApi> | null = null;

export function loadTurnstile(): Promise<TurnstileApi> {
	if (window.turnstile) return Promise.resolve(window.turnstile);
	if (loading) return loading;
	loading = new Promise<TurnstileApi>((resolve, reject) => {
		const script = document.createElement("script");
		script.src = SCRIPT;
		script.onload = () => {
			if (window.turnstile) resolve(window.turnstile);
			else reject(new Error("script"));
		};
		script.onerror = () => reject(new Error("script"));
		document.head.appendChild(script);
	}).catch((error) => {
		// Let the next widget try again rather than inherit this failure.
		loading = null;
		throw error;
	});
	return loading;
}
