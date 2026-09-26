self.addEventListener("install", () => {
	self.skipWaiting();
});

self.addEventListener("activate", (event) => {
	event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
	let data = { title: "Email Explorer", body: "", url: "/" };
	try {
		if (event.data) data = { ...data, ...event.data.json() };
	} catch {
		// ignore malformed payloads
	}

	// Sent when the email is read on another device: close the matching
	// notification here instead of showing a new one.
	if (data.type === "dismiss" && data.tag) {
		event.waitUntil(
			self.registration
				.getNotifications({ tag: data.tag })
				.then((notifications) => {
					for (const notification of notifications) {
						notification.close();
					}
				}),
		);
		return;
	}

	event.waitUntil(
		self.registration.showNotification(data.title, {
			body: data.body,
			icon: "/icon-192.png",
			badge: "/icon-192.png",
			// One notification per email (tag = email id) so Android stacks
			// them like Gmail's: a collapsed row with a count that expands
			// into the individual messages, each opening its own mail.
			tag: data.tag,
			data: { url: data.url },
		}),
	);
});

/**
 * Opens the message a notification is about.
 *
 * An open tab is asked to go there itself (a message the app turns into an
 * in-page navigation) rather than navigated from here: `client.navigate`
 * reloads the tab, which threw away whatever was being written in it, and it
 * rejects outright for a tab this worker does not control -- so the tab came
 * to the front and stayed where it was. A tab already showing that message
 * is only brought forward. With no tab open, a new one is opened.
 *
 * Only an address on this site is opened.
 */
self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const target = new URL(
		event.notification.data?.url || "/",
		self.location.origin,
	);
	if (target.origin !== self.location.origin) return;
	const path = target.pathname + target.search;

	event.waitUntil(
		self.clients
			.matchAll({ type: "window", includeUncontrolled: true })
			.then((clientList) => {
				const already = clientList.find((client) => {
					const at = new URL(client.url);
					return at.pathname === target.pathname;
				});
				if (already) return already.focus();

				const tab = clientList.find((client) => "focus" in client);
				if (tab) {
					tab.postMessage({ type: "open", url: path });
					return tab.focus();
				}
				if (self.clients.openWindow) {
					return self.clients.openWindow(path);
				}
			}),
	);
});
