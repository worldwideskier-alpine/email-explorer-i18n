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
 * Asks for nothing: no permission prompt, and nothing if permission is not
 * already granted. Failure changes nothing a person can see, so it is
 * swallowed.
 */
export async function rebindPushSubscription(): Promise<void> {
	try {
		if (!isPushSupported() || Notification.permission !== "granted") return;
		const subscription = await getExistingSubscription();
		if (!subscription) return;
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
