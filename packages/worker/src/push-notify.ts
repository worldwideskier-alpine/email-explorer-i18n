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
 * Deep link to a single email's body (`email/:id` under `/mailbox/:mailboxId`
 * in the dashboard router). `fromFolder` is what EmailDetail uses for its
 * back/move/spam actions, matching how the in-app list links to a message.
 * The mailbox id is an email address, so it needs encoding to match the form
 * the dashboard itself produces (e.g. `uota%40example.com`).
 */
export function mailboxEmailPath(mailboxId: string, emailId: string): string {
	return `/mailbox/${encodeURIComponent(mailboxId)}/email/${encodeURIComponent(
		emailId,
	)}?fromFolder=inbox`;
}

async function getMailboxLabel(env: Env, mailboxId: string): Promise<string> {
	const obj = await env.BUCKET.get(`mailboxes/${mailboxId}.json`);
	if (!obj) return mailboxId;
	const settings = await obj.json<{ fromName?: string }>();
	return settings?.fromName || mailboxId;
}

/**
 * Announces one newly arrived email as its own notification, tagged with the
 * email id. One notification per message (rather than a single per-mailbox
 * counter) is what lets Android stack them the way Gmail's do: a collapsed
 * row with a count badge that expands into the individual messages, each
 * opening its own mail and dismissable on its own.
 *
 * The mailbox's display name leads the title because the stack's header is
 * the site name, which is the same for every mailbox and so can't tell
 * info@ apart from uota@ on its own.
 */
export function buildNewEmailPayload(
	mailboxId: string,
	mailboxLabel: string,
	email: { id: string; sender: string; subject: string },
): { title: string; body: string; url: string; tag: string } {
	return {
		title: `[${mailboxLabel}] ${email.sender || mailboxId}`,
		body: email.subject,
		url: mailboxEmailPath(mailboxId, email.id),
		// Unique per message: a shared tag would make each new mail replace
		// the previous notification instead of stacking beside it.
		tag: email.id,
	};
}

export async function notifyNewEmail(
	env: Env,
	mailboxId: string,
	email: { id: string; sender: string; subject: string },
): Promise<void> {
	const mailboxLabel = await getMailboxLabel(env, mailboxId);
	await notifyMailboxSubscribers(
		env,
		mailboxId,
		buildNewEmailPayload(mailboxId, mailboxLabel, email),
	);
}

/**
 * Closes the notification for one specific email on every subscribed device
 * without showing anything new -- used when the message gets marked read
 * somewhere else, e.g. opened on a PC while the phone still shows it.
 */
export async function dismissEmailNotification(
	env: Env,
	mailboxId: string,
	emailId: string,
): Promise<void> {
	await notifyMailboxSubscribers(env, mailboxId, {
		type: "dismiss",
		tag: emailId,
		title: "",
		body: "",
		url: "",
	});
}
