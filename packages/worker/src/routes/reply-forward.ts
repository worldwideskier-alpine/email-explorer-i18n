import { contentJson, OpenAPIRoute } from "chanfana";
import type { Context } from "hono";
import { z } from "zod";
import { base64ToBytes } from "../base64";
import { plainTextToHtml } from "../plain-text-to-html";
import { formatAddressList } from "../recipients";
import { sendEmail } from "../resend";
import type { Env, Session } from "../types";

type AppContext = Context<{ Bindings: Env; Variables: { session?: Session } }>;

const SendEmailRequestSchema = z
	.object({
		// At least one address: the array form would otherwise let an empty
		// list through, which the single-string form never could.
		to: z.union([z.string().email(), z.array(z.string().email()).min(1)]),
		cc: z.union([z.string().email(), z.array(z.string().email())]).optional(),
		bcc: z.union([z.string().email(), z.array(z.string().email())]).optional(),
		from: z.string().email(),
		subject: z.string(),
		html: z.string().optional(),
		text: z.string().optional(),
		attachments: z
			.array(
				z.object({
					content: z.string(), // base64 encoded
					filename: z.string(),
					type: z.string(),
					disposition: z.enum(["attachment", "inline"]),
					contentId: z.string().optional(),
				}),
			)
			.optional(),
		in_reply_to: z.string().optional(),
		references: z.array(z.string()).optional(),
		thread_id: z.string().optional(),
	})
	.refine((data) => data.html || data.text, {
		message: "Either 'html' or 'text' must be provided",
	});

const SendEmailResponseSchema = z.object({
	id: z.string(),
	status: z.string(),
});

const ErrorResponseSchema = z.object({
	error: z.string(),
});

export class PostReplyEmail extends OpenAPIRoute {
	schema = {
		summary: "Reply to an email",
		operationId: "replyToEmail",
		tags: ["Emails"],
		request: {
			params: z.object({
				mailboxId: z.string(),
				id: z.string(),
			}),
			body: contentJson(SendEmailRequestSchema),
		},
		responses: {
			"201": {
				description: "Reply sent successfully",
				...contentJson(SendEmailResponseSchema),
			},
			"400": {
				description: "Bad request",
				...contentJson(ErrorResponseSchema),
			},
			"404": {
				description: "Original email not found",
				...contentJson(ErrorResponseSchema),
			},
		},
	};

	async handle(c: AppContext) {
		const data = await this.getValidatedData<typeof this.schema>();
		const { mailboxId, id } = data.params;
		const { to, cc, bcc, from, subject, html, text, attachments } = data.body;

		const key = `mailboxes/${mailboxId}.json`;
		const obj = await c.env.BUCKET.head(key);
		if (!obj) {
			return c.json({ error: "Not found" }, 404);
		}

		// Get the original email to extract threading info
		const ns = c.env.MAILBOX;
		const doId = ns.idFromName(mailboxId);
		const stub = ns.get(doId);
		const originalEmail = (await stub.getEmail(id)) as any;

		if (!originalEmail) {
			return c.json({ error: "Original email not found" }, 404);
		}

		// Build threading information
		const in_reply_to = originalEmail.id;
		const references = originalEmail.email_references
			? [
					...JSON.parse(originalEmail.email_references as string),
					originalEmail.id,
				]
			: [originalEmail.id];
		const thread_id = originalEmail.thread_id || originalEmail.id;

		try {
			await sendEmail(
				c.env,
				{
					from,
					to,
					cc,
					bcc,
					subject,
					text,
					html,
					attachments: attachments?.map((att) => ({
						filename: att.filename,
						content: att.content,
						type: att.type,
					})),
					inReplyTo: in_reply_to,
					references: references,
				},
				// Sent by whoever holds this mailbox, and billed to their key.
				c.get("session")?.personId,
			);
		} catch (e) {
			return c.json({ error: (e as Error).message }, 500);
		}

		const messageId = crypto.randomUUID();

		const attachmentData = [];
		if (attachments) {
			for (const att of attachments) {
				const attachmentId = crypto.randomUUID();
				const key = `attachments/${messageId}/${attachmentId}/${att.filename}`;
				const decoded = base64ToBytes(att.content);
				await c.env.BUCKET.put(key, decoded);
				attachmentData.push({
					id: attachmentId,
					email_id: messageId,
					filename: att.filename,
					mimetype: att.type,
					size: decoded.length,
					content_id: att.contentId || null,
					disposition: att.disposition,
				});
			}
		}

		await stub.createEmail(
			"sent",
			{
				id: messageId,
				subject,
				sender: from,
				recipient: formatAddressList(to) ?? "",
				cc: formatAddressList(cc),
				bcc: formatAddressList(bcc),
				date: new Date().toISOString(),
				body: html || (text ? plainTextToHtml(text) : ""),
				in_reply_to: in_reply_to,
				email_references: JSON.stringify(references),
				thread_id: thread_id,
			},
			attachmentData,
		);

		return c.json({ id: messageId, status: "sent" }, 201);
	}
}

export class PostForwardEmail extends OpenAPIRoute {
	schema = {
		summary: "Forward an email",
		operationId: "forwardEmail",
		tags: ["Emails"],
		request: {
			params: z.object({
				mailboxId: z.string(),
				id: z.string(),
			}),
			body: contentJson(SendEmailRequestSchema),
		},
		responses: {
			"201": {
				description: "Email forwarded successfully",
				...contentJson(SendEmailResponseSchema),
			},
			"400": {
				description: "Bad request",
				...contentJson(ErrorResponseSchema),
			},
			"404": {
				description: "Original email not found",
				...contentJson(ErrorResponseSchema),
			},
		},
	};

	async handle(c: AppContext) {
		const data = await this.getValidatedData<typeof this.schema>();
		const { mailboxId, id } = data.params;
		const { to, cc, bcc, from, subject, html, text, attachments } = data.body;

		const key = `mailboxes/${mailboxId}.json`;
		const obj = await c.env.BUCKET.head(key);
		if (!obj) {
			return c.json({ error: "Not found" }, 404);
		}

		// Get the original email
		const ns = c.env.MAILBOX;
		const doId = ns.idFromName(mailboxId);
		const stub = ns.get(doId);
		const originalEmail = (await stub.getEmail(id)) as any;

		if (!originalEmail) {
			return c.json({ error: "Original email not found" }, 404);
		}

		// Forwarded emails don't have threading headers

		try {
			await sendEmail(
				c.env,
				{
					from,
					to,
					cc,
					bcc,
					subject,
					text,
					html,
					attachments: attachments?.map((att) => ({
						filename: att.filename,
						content: att.content,
						type: att.type,
					})),
				},
				// Sent by whoever holds this mailbox, and billed to their key.
				c.get("session")?.personId,
			);
		} catch (e) {
			return c.json({ error: (e as Error).message }, 500);
		}

		const messageId = crypto.randomUUID();

		const attachmentData = [];
		if (attachments) {
			for (const att of attachments) {
				const attachmentId = crypto.randomUUID();
				const key = `attachments/${messageId}/${attachmentId}/${att.filename}`;
				const decoded = base64ToBytes(att.content);
				await c.env.BUCKET.put(key, decoded);
				attachmentData.push({
					id: attachmentId,
					email_id: messageId,
					filename: att.filename,
					mimetype: att.type,
					size: decoded.length,
					content_id: att.contentId || null,
					disposition: att.disposition,
				});
			}
		}

		await stub.createEmail(
			"sent",
			{
				id: messageId,
				subject,
				sender: from,
				recipient: formatAddressList(to) ?? "",
				cc: formatAddressList(cc),
				bcc: formatAddressList(bcc),
				date: new Date().toISOString(),
				body: html || (text ? plainTextToHtml(text) : ""),
				in_reply_to: null,
				email_references: null,
				thread_id: messageId,
			},
			attachmentData,
		);

		return c.json({ id: messageId, status: "sent" }, 201);
	}
}
