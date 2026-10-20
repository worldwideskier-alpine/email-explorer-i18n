import { useAuthStore } from "@/stores/auth";
import { somethingIsBeingWritten } from "./appUpdate";
import { rebindPushSubscription, toldToOpenTheApp } from "./push";

/**
 * What an open tab does when the service worker says a notification was
 * tapped (sw.js): show what it was about, inside the page rather than by a
 * reload, so nothing on screen is thrown away.
 *
 * Only an address on this site. And not at all while something is being
 * written: the tab comes to the front and stays where it is, as a new build
 * waits (appUpdate.ts). A tap on a notification is not a decision to leave
 * what is half written.
 */
export function openWhatWasTapped(
	data: unknown,
	go: (url: string) => void,
): void {
	const message = data as { type?: unknown; url?: unknown } | null;
	const url = message?.type === "open" ? message.url : null;
	if (
		typeof url === "string" &&
		url.startsWith("/") &&
		!url.startsWith("//") &&
		!somethingIsBeingWritten(document)
	) {
		go(url);
	}
}

/**
 * Listens for what the notifications ask of an open tab: a tap, and the tab
 * coming to the front while an "open the app" notification is showing.
 *
 * Either, in a tab with a session, hands this browser's subscription to that
 * session again (rebindPushSubscription), which also closes the "open the
 * app" notifications. A tab kept open past its device's subscription being
 * bound -- a row from before rows named a session, or a hand-over the Worker
 * refused -- is signed in, and opening it changed nothing: the tap went to
 * /login, which a signed-in tab is sent away from, and the session is asked
 * about once per page. The notice came every day, and after thirty days
 * stopped. The front-of-screen case is for a tab opened from the home screen
 * rather than by the tap; it asks the browser alone, so switching back to
 * the app costs no request.
 */
export function listenForNotifications(
	container: Pick<
		ServiceWorkerContainer,
		"addEventListener" | "removeEventListener"
	>,
	go: (url: string) => void,
): () => void {
	const signedIn = () => useAuthStore().session !== null;
	const tapped = (event: Event) => {
		const data = (event as MessageEvent).data as { type?: unknown } | null;
		if (data?.type === "open" && signedIn()) void rebindPushSubscription();
		openWhatWasTapped(data, go);
	};
	const toTheFront = async () => {
		if (document.visibilityState !== "visible" || !signedIn()) return;
		if (await toldToOpenTheApp()) void rebindPushSubscription();
	};
	container.addEventListener("message", tapped);
	document.addEventListener("visibilitychange", toTheFront);
	return () => {
		container.removeEventListener("message", tapped);
		document.removeEventListener("visibilitychange", toTheFront);
	};
}
