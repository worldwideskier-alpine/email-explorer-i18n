import type { Env } from "./types";

interface ResendAttachment {
	filename: string;
	content: string; // base64
	type: string;
}

interface SendEmailParams {
	from: string;
	to: string | string[];
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

	const res = await fetch("https://api.resend.com/emails", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${env.RESEND_API_KEY}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			from: params.from,
			to: params.to,
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
		throw new Error(
			`Resend API error: ${res.status} ${await res.text()} (RESEND_API_KEY length: ${env.RESEND_API_KEY?.length ?? "undefined"})`,
		);
	}
}
