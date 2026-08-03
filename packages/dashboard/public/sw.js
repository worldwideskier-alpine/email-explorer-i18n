self.addEventListener("push", (event) => {
	let data = { title: "Email Explorer", body: "", url: "/" };
	try {
		if (event.data) data = { ...data, ...event.data.json() };
	} catch {
		// ignore malformed payloads
	}

	event.waitUntil(
		self.registration.showNotification(data.title, {
			body: data.body,
			icon: "/icon-192.png",
			badge: "/icon-192.png",
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
					if (client.url.endsWith(url) && "focus" in client) {
						return client.focus();
					}
				}
				if (self.clients.openWindow) {
					return self.clients.openWindow(url);
				}
			}),
	);
});
