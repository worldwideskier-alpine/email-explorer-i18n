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
