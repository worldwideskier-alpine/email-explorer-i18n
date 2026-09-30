import { getResendApiKey } from "./app-settings";
import { asMessageId } from "./message-id";
import type { Env } from "./types";

interface ResendAttachment {
	filename: string;
	content: string; // base64
	type: string;
	disposition?: "attachment" | "inline";
	/** What the HTML names it by, as `cid:...`, when it is inline. */
	contentId?: string;
}

/**
 * The id an inline picture is named by, as Resend's `content_id` takes it:
 * bare, without the angle brackets a Content-ID header carries (its own SDK
 * takes them off too). Resend writes it into a header of the message, so
 * anything but visible ASCII is refused rather than passed on; the file then
 * goes as an ordinary attachment.
 */
export function asContentId(value: string | undefined): string | undefined {
	const bare = (value ?? "").trim().replace(/^<(.*)>$/, "$1");
	return /^[\x21-\x3b\x3d\x3f-\x7e]+$/.test(bare) ? bare : undefined;
}

interface SendEmailParams {
	from: string;
	to: string | string[];
	cc?: string | string[];
	bcc?: string | string[];
	subject: string;
	html?: string;
	text?: string;
	attachments?: ResendAttachment[];
	inReplyTo?: string;
	references?: string[];
}

/**
 * Sends one message, through the key of the person it belongs to.
 *
 * Every caller has to say whose mail this is, because the answer decides who
 * pays for it. A mailbox's outbound mail belongs to the person holding that
 * mailbox; a password reset belongs to the person being reset; root's own
 * account mail belongs to root. There is no "the deployment's mail" that
 * quietly bills somebody else.
 */
export async function sendEmail(
	env: Env,
	params: SendEmailParams,
	personId?: string | null,
): Promise<void> {
	// The last place a sender's string becomes one of our headers.
	const headers: Record<string, string> = {};
	const inReplyTo = asMessageId(params.inReplyTo);
	if (inReplyTo) headers["In-Reply-To"] = `<${inReplyTo}>`;
	const references = (params.references ?? [])
		.map(asMessageId)
		.filter((id): id is string => id !== null);
	if (references.length) {
		headers.References = references.map((id) => `<${id}>`).join(" ");
	}

	// Resolved per send rather than captured once: the key can be changed on
	// the settings screen, and the next message has to use the new one
	// without a redeploy.
	const apiKey = await getResendApiKey(env, personId);
	if (!apiKey) {
		throw new Error(
			"No Resend API key is configured. Set one on the admin screen.",
		);
	}

	const res = await fetch("https://api.resend.com/emails", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			from: params.from,
			to: params.to,
			// Resend keeps bcc out of the delivered headers, so a blind copy
			// stays blind. Both are omitted entirely when empty rather than
			// sent as [], which the API rejects.
			cc: params.cc?.length ? params.cc : undefined,
			bcc: params.bcc?.length ? params.bcc : undefined,
			subject: params.subject,
			html: params.html,
			text: params.text,
			headers: Object.keys(headers).length ? headers : undefined,
			attachments: params.attachments?.map((att) => ({
				filename: att.filename,
				content: att.content,
				content_type: att.type,
				// Without it an inline picture went as a plain attachment, and
				// the HTML's cid: reference pointed at nothing: the picture was
				// missing from the message and listed below it instead.
				content_id:
					att.disposition === "inline" ? asContentId(att.contentId) : undefined,
			})),
		}),
	});

	if (!res.ok) {
		throw new Error(`Resend API error: ${res.status} ${await res.text()}`);
	}
}
