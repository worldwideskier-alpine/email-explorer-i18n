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

/**
 * Path the notification opens. Must stay in sync with the dashboard's
 * router: the inbox list lives at `/mailbox/:mailboxId/emails/:folder`, so
 * dropping the `emails/` segment lands on the catch-all 404 route instead.
 * The mailbox id is an email address, so it needs encoding to match the
 * form the dashboard itself produces (e.g. `uota%40example.com`).
 */
export function mailboxInboxPath(mailboxId: string): string {
	return `/mailbox/${encodeURIComponent(mailboxId)}/emails/inbox`;
}

async function getMailboxLabel(env: Env, mailboxId: string): Promise<string> {
	const obj = await env.BUCKET.get(`mailboxes/${mailboxId}.json`);
	if (!obj) return mailboxId;
	const settings = await obj.json<{ fromName?: string }>();
	return settings?.fromName || mailboxId;
}

/**
 * Recomputes the mailbox's current unread-inbox count and updates (or
 * closes) that mailbox's single aggregate push notification to match,
 * instead of showing one notification per email. Every device gets one
 * notification per mailbox, tagged with the mailbox id, so unread mail
 * from different mailboxes never mixes together in the notification list.
 *
 * Call with alert:true when new mail just arrived (the phone should
 * actually buzz/alert), and alert:false when an email was simply marked
 * read (the count should update silently, or the notification should
 * disappear once nothing is left unread).
 */
export async function syncMailboxNotification(
	env: Env,
	mailboxId: string,
	options: { alert: boolean },
): Promise<void> {
	const ns = env.MAILBOX;
	const stub = ns.get(ns.idFromName(mailboxId));
	const summary = await stub.getUnreadInboxSummary();

	if (!summary) {
		await notifyMailboxSubscribers(env, mailboxId, {
			type: "dismiss",
			tag: mailboxId,
			title: "",
			body: "",
			url: "",
		});
		return;
	}

	const mailboxLabel = await getMailboxLabel(env, mailboxId);

	await notifyMailboxSubscribers(env, mailboxId, {
		title: `[${mailboxLabel}] 未読${summary.count}件`,
		body: `${summary.latestSender}: ${summary.latestSubject}`,
		url: mailboxInboxPath(mailboxId),
		tag: mailboxId,
		renotify: options.alert ? "true" : "false",
	});
}
