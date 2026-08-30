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

export async function sendEmail(
	env: Env,
	params: SendEmailParams,
): Promise<void> {
	const headers: Record<string, string> = {};
	if (params.inReplyTo) headers["In-Reply-To"] = `<${params.inReplyTo}>`;
	if (params.references?.length) {
		headers.References = params.references.map((id) => `<${id}>`).join(" ");
	}

	// Resolved per send rather than captured once: an administrator can change
	// the key on the admin screen, and the next message has to use the new one
	// without a redeploy.
	const apiKey = await getResendApiKey(env);
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
