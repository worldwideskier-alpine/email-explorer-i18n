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
			tag: data.tag,
			// One notification per mailbox (tag = mailboxId): a same-tag push
			// normally updates it silently, so force a fresh alert (sound/
			// vibration) only when the payload says new mail actually arrived.
			renotify: data.renotify === "true",
			data: { url: data.url },
		}),
	);
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const url = event.notification.data?.url || "/";

	event.waitUntil(
		self.clients
			.matchAll({ type: "window", includeUncontrolled: true })
			.then((clientList) => {
				for (const client of clientList) {
					if ("focus" in client) {
						if ("navigate" in client) {
							client.navigate(url);
						}
						return client.focus();
					}
				}
				if (self.clients.openWindow) {
					return self.clients.openWindow(url);
				}
			}),
	);
});
