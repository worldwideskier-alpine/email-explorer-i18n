import { buildPushHTTPRequest } from "@pushforge/builder";
import type { Env } from "./types";

interface NotifyPayload {
	title: string;
	body: string;
	url: string;
	[key: string]: string;
}

/**
 * Sends a Web Push notification to every device subscribed by the given
 * users. Best-effort: a failed/expired subscription is removed and never
 * throws, so a push failure can't break email ingestion.
 */
export async function notifyMailboxSubscribers(
	env: Env,
	mailboxId: string,
	payload: NotifyPayload,
): Promise<void> {
	if (!env.VAPID_PRIVATE_KEY) return;

	const authId = env.MAILBOX.idFromName("AUTH");
	const authDO = env.MAILBOX.get(authId);

	const userIds = await authDO.getUserIdsForMailbox(mailboxId);
	if (userIds.length === 0) return;

	const subscriptions = await authDO.getPushSubscriptionsForUsers(userIds);
	if (subscriptions.length === 0) return;

	const privateJWK = JSON.parse(env.VAPID_PRIVATE_KEY);

	await Promise.all(
		subscriptions.map(async (sub) => {
			try {
				const { endpoint, headers, body } = await buildPushHTTPRequest({
					privateJWK,
					subscription: {
						endpoint: sub.endpoint,
						keys: { p256dh: sub.p256dh, auth: sub.auth },
					},
					message: {
						payload,
						adminContact: "mailto:info@beautifulsnow.co.jp",
						options: { ttl: 3600, urgency: "high" },
					},
				});

				const res = await fetch(endpoint, { method: "POST", headers, body });

				if (res.status === 404 || res.status === 410) {
					await authDO.removePushSubscription(sub.endpoint);
				}
			} catch (e) {
				console.error(`Failed to send push to ${sub.endpoint}:`, e);
			}
		}),
	);
}
