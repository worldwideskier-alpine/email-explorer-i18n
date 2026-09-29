import { contentJson, OpenAPIRoute } from "chanfana";
import type { Context } from "hono";
import { z } from "zod";
import { sendsAsMailbox } from "../mailbox-access";
import { plainTextToHtml } from "../plain-text-to-html";
import { formatAddressList } from "../recipients";
import { sendEmail } from "../resend";
import { keepSentCopy, prepareAttachments } from "../sent-copy";
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
	/** False when the message left but its copy in Sent could not be kept. */
	saved: z.boolean().optional(),
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

		if (!sendsAsMailbox(from, mailboxId)) {
			return c.json({ error: "The sender must be this mailbox" }, 403);
		}

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

		const { in_reply_to, references, thread_id } =
			replyThreading(originalEmail);

		// Asked before the message leaves; see sent-copy.ts.
		const prepared = prepareAttachments(attachments);
		if (!prepared) {
			return c.json({ error: "An attachment is not valid base64" }, 400);
		}

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
					inReplyTo: in_reply_to ?? undefined,
					references: references,
				},
				// Sent by whoever holds this mailbox, and billed to their key.
				c.get("session")?.personId,
			);
		} catch (e) {
			return c.json({ error: (e as Error).message }, 500);
		}

		const messageId = crypto.randomUUID();

		const saved = await keepSentCopy(
			c.env,
			stub,
			messageId,
			{
				subject,
				sender: from,
				recipient: formatAddressList(to) ?? "",
				cc: formatAddressList(cc),
				bcc: formatAddressList(bcc),
				date: new Date().toISOString(),
				body: html || (text ? plainTextToHtml(text) : ""),
				in_reply_to: in_reply_to,
				email_references: references.length ? JSON.stringify(references) : null,
				thread_id: thread_id,
			},
			prepared,
		);

		// Sent either way: a 500 here would invite a second send.
		return c.json({ id: messageId, status: "sent", saved }, 201);
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

		if (!sendsAsMailbox(from, mailboxId)) {
			return c.json({ error: "The sender must be this mailbox" }, 403);
		}

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

		// Asked before the message leaves; see sent-copy.ts.
		const prepared = prepareAttachments(attachments);
		if (!prepared) {
			return c.json({ error: "An attachment is not valid base64" }, 400);
		}

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

		const saved = await keepSentCopy(
			c.env,
			stub,
			messageId,
			{
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
			prepared,
		);

		// Sent either way: a 500 here would invite a second send.
		return c.json({ id: messageId, status: "sent", saved }, 201);
	}
}

/**
 * What a reply says it answers, in the headers the other side's client
 * threads by.
 *
 * In-Reply-To and References name Message-IDs, and the only one a stored
 * message has is the sender's (`message_id`). These used to carry the row's
 * own id: a name no client has ever seen, so the reply started a thread of
 * its own on the other side -- and an internal id went out in every reply.
 * A message with no Message-ID of its own (mail sent from here, or stored
 * before it was kept) gives no In-Reply-To rather than a made-up one, and
 * references left over from those rows are dropped the same way: every
 * real Message-ID has an "@", and none of ours do.
 *
 * `thread_id` stays ours, since only this mailbox reads it.
 */
export function replyThreading(parent: {
	id: string;
	message_id?: string | null;
	email_references?: string | null;
	thread_id?: string | null;
}): {
	in_reply_to: string | null;
	references: string[];
	thread_id: string;
} {
	const isMessageId = (value: unknown): value is string =>
		typeof value === "string" && value.includes("@");
	let earlier: unknown[] = [];
	try {
		const parsed = JSON.parse(parent.email_references ?? "[]");
		if (Array.isArray(parsed)) earlier = parsed;
	} catch {
		// A row whose references cannot be read still gets its reply threaded
		// by In-Reply-To.
	}
	const in_reply_to = isMessageId(parent.message_id) ? parent.message_id : null;
	const references = earlier.filter(isMessageId);
	if (in_reply_to && !references.includes(in_reply_to)) {
		references.push(in_reply_to);
	}
	return {
		in_reply_to,
		references,
		thread_id: parent.thread_id || parent.id,
	};
}
