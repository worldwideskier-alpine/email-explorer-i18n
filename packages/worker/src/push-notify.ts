import { buildPushHTTPRequest } from "@pushforge/builder";
import type { MailboxDO, PushTarget } from "./durableObject";
import { openTheAppNotice } from "./push-notice";
import type { Env } from "./types";

interface NotifyPayload {
	title: string;
	body: string;
	url: string;
	[key: string]: string;
}

type AuthStub = DurableObjectStub<MailboxDO>;

/**
 * Sends one payload to each of `targets`, and says which push services took
 * it and which did not. A failed or expired subscription is removed and does
 * not stop the others; nothing here throws for one device.
 *
 * Took it, not was asked: this used to answer the number of subscriptions
 * whatever each send did, so a message whose every send failed was recorded
 * as announced, and reading it later sent a dismissal to devices that had
 * never shown it -- the push that shows nothing, which is how a browser
 * comes to withdraw a subscription.
 */
async function sendToEach(
	env: Env,
	authDO: AuthStub,
	mailboxId: string,
	targets: PushTarget[],
	payloadFor: (target: PushTarget) => NotifyPayload,
): Promise<{ took: number; refused: PushTarget[] }> {
	if (targets.length === 0 || !env.VAPID_PRIVATE_KEY) {
		return { took: 0, refused: targets };
	}
	const privateJWK = JSON.parse(env.VAPID_PRIVATE_KEY);

	// RFC 8292 wants a way for a push service to reach whoever runs this
	// application server. That is deployment-specific, so it comes from a var
	// rather than being baked into the package. The mailbox's own address is
	// a sound fallback: on a self-hosted deployment, the person reading this
	// mailbox is the operator.
	const adminContact = env.VAPID_ADMIN_CONTACT?.trim() || `mailto:${mailboxId}`;

	const accepted = await Promise.all(
		targets.map(async (sub) => {
			try {
				const { endpoint, headers, body } = await buildPushHTTPRequest({
					privateJWK,
					subscription: {
						endpoint: sub.endpoint,
						keys: { p256dh: sub.p256dh, auth: sub.auth },
					},
					message: {
						payload: payloadFor(sub),
						adminContact,
						options: { ttl: 3600, urgency: "high" },
					},
				});

				// Bounded: this runs inside mail delivery, and a push service
				// that does not answer held the delivery for as long as it
				// liked. A notification that could not be sent is only that.
				const res = await fetch(endpoint, {
					method: "POST",
					headers,
					body,
					signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
				});

				if (res.status === 404 || res.status === 410) {
					await authDO.forgetGonePushEndpoint(sub.endpoint);
				} else if (!res.ok) {
					// Which push service, and what it said. A refusal used to
					// leave no trace at all, so a device that stopped hearing
					// anything was a question nobody could answer from the logs.
					console.error(
						`Push refused by ${pushServiceOf(sub.endpoint)}: ${res.status}`,
					);
				}
				return res.ok;
			} catch (e) {
				// The host and the kind of failure, never the endpoint: its path
				// is what a push service delivers to, and anyone holding it can
				// address that device. Nor the error's text, which may quote it.
				console.error(
					`Failed to send push to ${pushServiceOf(sub.endpoint)}: ${
						e instanceof Error ? e.name : typeof e
					}`,
				);
				return false;
			}
		}),
	);
	return {
		took: accepted.filter(Boolean).length,
		refused: targets.filter((_, i) => !accepted[i]),
	};
}

/**
 * The push service an endpoint belongs to, by host alone -- the part of it
 * that may be logged. See sendToEach.
 */
export function pushServiceOf(endpoint: string): string {
	try {
		return new URL(endpoint).host;
	} catch {
		return "an endpoint that is not a URL";
	}
}

/**
 * Apple's push service. A push that shows nothing is what Safari is
 * documented to revoke the permission over, so a dismissal -- which is
 * exactly that -- is never sent there. A notification Safari shows stays
 * until it is tapped or cleared.
 */
export function isApplePush(endpoint: string): boolean {
	const host = pushServiceOf(endpoint).toLowerCase();
	return host === "web.push.apple.com" || host.endsWith(".push.apple.com");
}

/** The logins holding a mailbox, and the auth object that knows them. */
async function holdersOf(env: Env, mailboxId: string) {
	const authDO = env.MAILBOX.get(env.MAILBOX.idFromName("AUTH"));
	const userIds = await authDO.getUserIdsForMailbox(mailboxId);
	return { authDO, userIds };
}

/**
 * What a device whose session has run out is sent instead of the message:
 * that there is new mail and to open the app, in its language. No sender,
 * subject, mailbox or message: the device may be one its owner has lost,
 * which is the reason a session ends at all.
 *
 * One tag for all of them, so a later one replaces the one before rather
 * than stacking beside it; pushTargetsForNewMail sends at most one a day.
 */
export function openTheAppPayload(locale: string | null): {
	title: string;
	body: string;
	url: string;
	tag: string;
} {
	return {
		title: "Email Explorer",
		body: openTheAppNotice(locale),
		url: "/login",
		tag: OPEN_THE_APP_TAG,
	};
}

/** The tag of openTheAppPayload; the dashboard closes these when it is back. */
export const OPEN_THE_APP_TAG = "open-app";

/** How long one push service is waited for. */
const PUSH_TIMEOUT_MS = 10_000;

/**
 * Deep link to a single email's body (`email/:id` under `/mailbox/:mailboxId`
 * in the dashboard router). `fromFolder` is what EmailDetail uses for its
 * back/move/spam actions, matching how the in-app list links to a message.
 * The mailbox id is an email address, so it needs encoding to match the form
 * the dashboard itself produces (e.g. `owner%40example.com`).
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
 * the site name, which is the same for every mailbox and so can't tell one
 * mailbox's notifications from another's on its own.
 */
export function buildNewEmailPayload(
	mailboxId: string,
	mailboxLabel: string,
	email: { id: string; sender: string; subject: string },
): { title: string; body: string; url: string; tag: string } {
	return {
		title: `[${mailboxLabel}] ${email.sender || mailboxId}`.slice(0, 200),
		// Push services refuse a payload over about 4KB, and a subject is the
		// sender's to make as long as they like.
		body: email.subject.slice(0, 500),
		url: mailboxEmailPath(mailboxId, email.id),
		// Unique per message: a shared tag would make each new mail replace
		// the previous notification instead of stacking beside it.
		tag: email.id,
	};
}

/**
 * Never throws. It runs after the message is stored, inside the delivery of
 * that message, so anything escaping from here -- the label read, the auth
 * Durable Object, a malformed VAPID key -- failed the delivery of mail that
 * had already arrived: a bounce, or a second copy when the sender retried.
 * Only the send to each device was guarded before.
 *
 * Devices whose session is still good are told the sender and subject;
 * those whose session has run out are told only to open the app, at most
 * once a day (pushTargetsForNewMail). Answers whether any of the first took
 * it, which is what decides whether the message is dismissed later.
 */
export async function notifyNewEmail(
	env: Env,
	mailboxId: string,
	email: { id: string; sender: string; subject: string },
): Promise<boolean> {
	try {
		if (!env.VAPID_PRIVATE_KEY) return false;
		const { authDO, userIds } = await holdersOf(env, mailboxId);
		if (userIds.length === 0) return false;
		const { live, lapsed, noticeAt } =
			await authDO.pushTargetsForNewMail(userIds);
		// The label is only the title's first words: a settings object that
		// cannot be read costs it, not the notifications -- the lapsed
		// devices' among them, whose day's notice is already marked as sent.
		const mailboxLabel =
			live.length > 0
				? await getMailboxLabel(env, mailboxId).catch(() => mailboxId)
				: mailboxId;
		const message = buildNewEmailPayload(mailboxId, mailboxLabel, email);
		const [devices, reminded] = await Promise.all([
			sendToEach(env, authDO, mailboxId, live, () => message),
			// Not counted: the message is announced only where a device was
			// shown it, and only those are sent its dismissal later.
			sendToEach(env, authDO, mailboxId, lapsed, (target) =>
				openTheAppPayload(target.locale),
			),
		]);
		if (reminded.refused.length > 0) {
			await authDO.lapsedNoticesNotSent(
				reminded.refused.map((target) => target.endpoint),
				noticeAt,
			);
		}
		return devices.took > 0;
	} catch (e) {
		console.error("Push notification failed:", e);
		return false;
	}
}

/**
 * Closes the notification for one specific email on every subscribed device
 * without showing anything new -- used when the message gets marked read
 * somewhere else, e.g. opened on a PC while the phone still shows it.
 *
 * Only for a message that was announced: the mailbox's `takeNotified` says
 * so, and asking it is the caller's job, since the caller holds the stub.
 *
 * Never throws. It runs after the change it follows has been stored -- a
 * mark-read, a delete, a move -- and a bad VAPID key or an unavailable auth
 * object turned each of those into a 500 for something that had happened.
 */
export async function dismissEmailNotification(
	env: Env,
	mailboxId: string,
	emailId: string,
): Promise<void> {
	try {
		if (!env.VAPID_PRIVATE_KEY) return;
		const { authDO, userIds } = await holdersOf(env, mailboxId);
		if (userIds.length === 0) return;
		const targets = (await authDO.livePushTargets(userIds)).filter(
			(target) => !isApplePush(target.endpoint),
		);
		await sendToEach(env, authDO, mailboxId, targets, () => ({
			type: "dismiss",
			tag: emailId,
			title: "",
			body: "",
			url: "",
		}));
	} catch (e) {
		console.error("Push dismissal failed:", e);
	}
}
