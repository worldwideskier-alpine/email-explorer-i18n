import type PostalMime from "postal-mime";
import { plainTextToHtml } from "./plain-text-to-html";
import { notifyMailboxSubscribers } from "./push-notify";
import type { Env } from "./types";

/**
 * Shared by the real Cloudflare Email Routing trigger (receiveEmail in
 * index.ts) and the admin IMAP-import endpoint (PostImportEmail in
 * routes/import.ts): stores a postal-mime-parsed message into a mailbox's
 * Durable Object, handling attachment upload to R2 and threading-header
 * normalization identically for both paths.
 */
export async function ingestEmailIntoMailbox(
	env: Env,
	mailboxId: string,
	folder: string,
	parsedEmail: Awaited<ReturnType<PostalMime["parse"]>>,
	overrides: {
		date?: string;
		read?: boolean;
		starred?: boolean;
		notify?: boolean;
		rawEmail?: ArrayBuffer | Uint8Array;
	} = {},
) {
	const messageId = crypto.randomUUID();

	const key = `mailboxes/${mailboxId}.json`;
	const obj = await env.BUCKET.head(key);
	if (!obj) {
		await env.BUCKET.put(key, JSON.stringify({}));
	}

	if (overrides.rawEmail) {
		await env.BUCKET.put(`raw/${messageId}.eml`, overrides.rawEmail);
	}

	const ns = env.MAILBOX;
	const id = ns.idFromName(mailboxId);
	const stub = ns.get(id);

	const attachmentData = [];
	if (parsedEmail.attachments) {
		for (const att of parsedEmail.attachments) {
			const attachmentId = crypto.randomUUID();
			const attKey = `attachments/${messageId}/${attachmentId}/${att.filename}`;
			await env.BUCKET.put(attKey, att.content);
			attachmentData.push({
				id: attachmentId,
				email_id: messageId,
				filename: att.filename || "untitled",
				mimetype: att.mimeType,
				size:
					typeof att.content === "string"
						? att.content.length
						: att.content.byteLength,
				content_id: att.contentId || null,
				disposition: att.disposition,
			});
		}
	}

	// Strip angle brackets from message IDs since postal-mime returns raw RFC 2822
	// values (e.g. "<msg@example.com>") but we store bare IDs to match outgoing emails
	const stripBrackets = (s: string) => s.replace(/^</, "").replace(/>$/, "");
	const inReplyTo = parsedEmail.inReplyTo
		? stripBrackets(parsedEmail.inReplyTo)
		: null;
	const emailReferences = parsedEmail.references
		? parsedEmail.references.split(/\s+/).filter(Boolean).map(stripBrackets)
		: [];

	await stub.createEmail(
		folder,
		{
			id: messageId,
			subject: parsedEmail.subject || "",
			sender: parsedEmail.from?.address || "",
			recipient: parsedEmail.to?.[0]?.address || mailboxId,
			date: overrides.date || new Date().toISOString(),
			body:
				parsedEmail.html ||
				(parsedEmail.text ? plainTextToHtml(parsedEmail.text) : ""),
			in_reply_to: inReplyTo,
			email_references:
				emailReferences.length > 0 ? JSON.stringify(emailReferences) : null,
			thread_id: emailReferences[0] || inReplyTo || messageId,
		},
		attachmentData,
	);

	if (overrides.read || overrides.starred) {
		await stub.updateEmail(messageId, {
			read: overrides.read,
			starred: overrides.starred,
		});
	}

	if (overrides.notify && folder !== "spam") {
		await notifyMailboxSubscribers(env, mailboxId, {
			title: parsedEmail.from?.address || mailboxId,
			body: parsedEmail.subject || "",
			url: `/mailbox/${mailboxId}/emails/${folder}`,
		});
	}

	return messageId;
}
