import { getResendApiKey } from "./app-settings";
import type { Env } from "./types";

interface ResendAttachment {
	filename: string;
	content: string; // base64
	type: string;
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
	const headers: Record<string, string> = {};
	if (params.inReplyTo) headers["In-Reply-To"] = `<${params.inReplyTo}>`;
	if (params.references?.length) {
		headers.References = params.references.map((id) => `<${id}>`).join(" ");
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
			})),
		}),
	});

	if (!res.ok) {
		throw new Error(`Resend API error: ${res.status} ${await res.text()}`);
	}
}
