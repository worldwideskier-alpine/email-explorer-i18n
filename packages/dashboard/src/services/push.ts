import { i18n } from "@/i18n";
import api from "./api";

/**
 * The tag of what the Worker sends a device whose session has run out: "new
 * mail, open the app" (push-notify.ts there). Closed once this browser is
 * bound to a session again, since what it asked for has happened.
 */
const OPEN_THE_APP_TAG = "open-app";

/**
 * The subscription as the Worker keeps it, with the language this page
 * displays: a device whose session runs out is told to open the app in it.
 */
function withLocale(subscription: PushSubscription) {
	return { ...subscription.toJSON(), locale: i18n.global.locale.value };
}

export function isPushSupported(): boolean {
	return (
		"serviceWorker" in navigator &&
		"PushManager" in window &&
		"Notification" in window
	);
}

// Backed by an ArrayBuffer, which is what pushManager.subscribe takes as a
// BufferSource; since TypeScript 5.9 a bare Uint8Array may be backed by a
// SharedArrayBuffer too, and is refused there.
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
	const padding = "=".repeat((4 - (base64.length % 4)) % 4);
	const base64Safe = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
	const raw = atob(base64Safe);
	return Uint8Array.from([...raw].map((char) => char.charCodeAt(0)));
}

/** How long the service worker is waited for before push is given up on. */
const READY_WITHIN_MS = 10_000;

/**
 * The service worker's registration, or a rejection once READY_WITHIN_MS
 * has gone by. `navigator.serviceWorker.ready` never settles when no worker
 * is registered -- a browser that refused it, a private window, a build
 * served without sw.js -- and the settings switch waited on it for ever,
 * spinning, with nothing said.
 */
function registration(): Promise<ServiceWorkerRegistration> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new Error("The service worker did not start")),
			READY_WITHIN_MS,
		);
	});
	return Promise.race([navigator.serviceWorker.ready, late]).finally(() =>
		clearTimeout(timer),
	);
}

export async function getExistingSubscription(): Promise<PushSubscription | null> {
	if (!isPushSupported()) return null;
	// No worker, no subscription this page can see.
	const ready = await registration().catch(() => null);
	return ready ? ready.pushManager.getSubscription() : null;
}

/** The reader said no to notifications; only they can change that. */
export class PushPermissionDenied extends Error {
	constructor() {
		super("Notification permission was not granted");
		this.name = "PushPermissionDenied";
	}
}

export async function subscribeToPush(): Promise<void> {
	if (!isPushSupported()) {
		throw new Error("Push notifications are not supported in this browser");
	}

	const permission = await Notification.requestPermission();
	if (permission !== "granted") {
		throw new PushPermissionDenied();
	}

	const { data } = await api.getVapidPublicKey();
	if (!data.publicKey) {
		throw new Error("VAPID public key is not configured on the server");
	}

	const ready = await registration();
	const subscription = await ready.pushManager.subscribe({
		userVisibleOnly: true,
		applicationServerKey: urlBase64ToUint8Array(data.publicKey),
	});

	await api.subscribePush(withLocale(subscription));
}

/**
 * Whether two keys are the same bytes. A subscription remembers the key it
 * was made under as bytes; the Worker serves its key as base64url.
 */
function sameKey(a: Uint8Array, b: Uint8Array): boolean {
	return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/**
 * Tells the Worker that this browser's subscription, if it has one, belongs
 * to the session now signed in.
 *
 * The Worker delivers a notification only through a session that is still
 * good, and forgets a session's subscription when the session ends -- so
 * whoever is told about new mail is whoever is signed in. The browser keeps
 * its subscription across that, though, and the settings screen reads its
 * switch from the browser; without this, signing out and back in left the
 * switch on and the notifications off. Called once a session is known good.
 *
 * A subscription made under a key the Worker no longer has is made again
 * under the one it has, first. A push service refuses a push signed with any
 * key but the one the browser subscribed with, so once the Worker's key is
 * replaced (its secret deleted, and the next deploy makes a new one) every
 * device would stay subscribed, switch on, receiving nothing. Only when both
 * keys are known and differ: a browser that does not say which key it used,
 * or a Worker that serves none, gets what it got before.
 *
 * Asks for nothing: no permission prompt. A new subscription under a new key
 * is made only when permission is already granted, which is the only state
 * in which a browser may let a page subscribe without a tap. Whether
 * released browsers do has not been tried (WebKit's source says it does);
 * one that wants a tap refuses here, and the switch reads off until it is
 * turned on again. An existing subscription is sent back whatever the
 * permission reads: it used to be asked for that too, and a page opened
 * outside the installed app -- a notification opened in a browser tab on
 * Android -- may read a permission other than the app's (read from search
 * results, not observed), which would leave a device that had just signed
 * in again unbound and silent.
 *
 * Once the Worker has it, the "open the app" notifications are closed: the
 * app has been opened. Failure is swallowed: before the browser lets its old
 * subscription go it changes nothing, and after, it leaves the switch off,
 * which is then the truth.
 *
 * Also run when the language changes (the auth store), so the Worker tells
 * this device in the one it displays.
 */
export async function rebindPushSubscription(): Promise<void> {
	try {
		if (!isPushSupported()) return;
		const ready = await registration().catch(() => null);
		if (!ready) return;
		let subscription = await ready.pushManager.getSubscription();
		if (!subscription) return;
		const under = subscription.options?.applicationServerKey;
		if (under) {
			const served = await api
				.getVapidPublicKey()
				.then(({ data }) => data.publicKey as string)
				.catch(() => "");
			const key = served ? urlBase64ToUint8Array(served) : null;
			if (key && !sameKey(new Uint8Array(under), key)) {
				// Without the permission no new subscription can be made, and
				// the old one is signed for with a key the Worker no longer
				// has: nothing would reach it either way.
				if (Notification.permission !== "granted") return;
				// The Worker forgets the old one first. Left to the push
				// service, it would be tried, and refused, on every new
				// message until the service said it was gone. And the
				// browser lets go only once it has: a refusal here leaves
				// both as they were, for the next sign-in to try again.
				await api.unsubscribePush(subscription.endpoint);
				await subscription.unsubscribe();
				subscription = await ready.pushManager.subscribe({
					userVisibleOnly: true,
					applicationServerKey: key,
				});
			}
		}
		await api.subscribePush(withLocale(subscription));
		for (const shown of await ready.getNotifications({
			tag: OPEN_THE_APP_TAG,
		})) {
			shown.close();
		}
	} catch {
		// See above.
	}
}

/**
 * Whether an "open the app" notification is showing in this browser: the
 * Worker has told it, since its session ran out, that there is new mail.
 * Asks the browser alone, nothing on the network. Never throws.
 */
export async function toldToOpenTheApp(): Promise<boolean> {
	try {
		if (!isPushSupported()) return false;
		const registered = await navigator.serviceWorker.getRegistration();
		if (!registered) return false;
		const shown = await registered.getNotifications({ tag: OPEN_THE_APP_TAG });
		return shown.length > 0;
	} catch {
		return false;
	}
}

/**
 * Turning notifications off. The browser lets go of its subscription even
 * when telling the Worker failed: left subscribed, the device went on being
 * told about new mail with the switch reading off. The Worker's row then
 * goes when its push service says the subscription is gone.
 */
export async function unsubscribeFromPush(): Promise<void> {
	const subscription = await getExistingSubscription();
	if (!subscription) return;

	try {
		await api.unsubscribePush(subscription.endpoint);
	} finally {
		await subscription.unsubscribe();
	}
}

/** How long a sign-out waits for the browser to let go of its subscription. */
const LET_GO_WITHIN_MS = 2_000;

/**
 * Signing out on purpose: this browser lets go of its subscription, so it is
 * told nothing more. The Worker's row goes with the session (or when the push
 * service says the subscription is gone, if the sign-out did not reach it).
 *
 * Never waits for a service worker to start, unlike the switch: a browser
 * with none registered has nothing to let go of, and `ready` would hold the
 * sign-out for the whole of READY_WITHIN_MS. Nor for longer than
 * LET_GO_WITHIN_MS for the rest: the sign-out waits on this. Never throws.
 */
export async function letGoOfThisBrowsersSubscription(): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, LET_GO_WITHIN_MS);
	});
	const letGo = (async () => {
		try {
			if (!isPushSupported()) return;
			const registered = await navigator.serviceWorker.getRegistration();
			const subscription = await registered?.pushManager.getSubscription();
			await subscription?.unsubscribe();
		} catch {
			// Nothing more to be done from here.
		}
	})();
	await Promise.race([letGo, late]);
	clearTimeout(timer);
}
