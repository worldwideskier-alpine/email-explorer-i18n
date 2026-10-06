import api from "./api";

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

	await api.subscribePush(subscription.toJSON());
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
 * key but the one the browser subscribed with, so after the Worker's key was
 * replaced (its secret deleted, and the next deploy made a new one) every
 * device stayed subscribed, switch on, and received nothing. Only when both
 * keys are known and differ: a browser that does not say which key it used,
 * or a Worker that serves none, gets what it got before.
 *
 * Asks for nothing: no permission prompt, and nothing if permission is not
 * already granted -- which is also what lets the browser subscribe again
 * without a tap. Failure is swallowed: before the browser lets its old
 * subscription go it changes nothing, and after, it leaves the switch off,
 * which is then the truth.
 */
export async function rebindPushSubscription(): Promise<void> {
	try {
		if (!isPushSupported() || Notification.permission !== "granted") return;
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
				// The Worker forgets the old one first. Left to the push
				// service, it would be tried, and refused, on every new
				// message until the service said it was gone.
				await api.unsubscribePush(subscription.endpoint);
				await subscription.unsubscribe();
				subscription = await ready.pushManager.subscribe({
					userVisibleOnly: true,
					applicationServerKey: key,
				});
			}
		}
		await api.subscribePush(subscription.toJSON());
	} catch {
		// See above.
	}
}

export async function unsubscribeFromPush(): Promise<void> {
	const subscription = await getExistingSubscription();
	if (!subscription) return;

	await api.unsubscribePush(subscription.endpoint);
	await subscription.unsubscribe();
}
