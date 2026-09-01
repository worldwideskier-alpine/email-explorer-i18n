import { contentJson, fromHono, OpenAPIRoute } from "chanfana";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import PostalMime from "postal-mime";
import { z } from "zod";
import { getResendKeySource, setResendApiKey } from "./app-settings";
import { backupKeyPrefix } from "./auto-backup";
import { listBackups } from "./backup-writer";
import { base64ToBytes } from "./base64";
import { classifyWithClaude } from "./claude-spam-filter";
import { recoveryFromEmail } from "./deployment-config";
import { ingestEmailIntoMailbox } from "./email-ingest";
import { ensureLegacyMailboxGrants } from "./legacy-grants";
import { buildPasswordResetEmail, MAIL_LOCALES } from "./mail-templates";
import {
	getClaudeApiKey,
	getSenderVerdictOverride,
	isDeletionLocked,
	mergeMailboxSettings,
	recordSenderVerdict,
	redactMailboxSettings,
} from "./mailbox-settings";
import { renderMboxEntry } from "./mbox";
import { plainTextToHtml } from "./plain-text-to-html";
import { dismissEmailNotification } from "./push-notify";
import { formatAddressList } from "./recipients";
import { sendEmail } from "./resend";
import { roleOf } from "./roles";
import {
	DeleteOwnLogin,
	GetMe,
	GetUsers,
	PostAdminRegister,
	PostChangeEmail,
	PostChangePassword,
	PostConfirmEmailChange,
	PostLogin,
	PostLogout,
	PostRegister,
} from "./routes/auth";
import { PostDraftEmail, PutDraftEmail } from "./routes/drafts";
import { PostImportEmail } from "./routes/import";
import {
	GetVapidPublicKey,
	PostPushSubscribe,
	PostPushUnsubscribe,
} from "./routes/push";
import { PostForwardEmail, PostReplyEmail } from "./routes/reply-forward";
import {
	DeleteAccount,
	GetAccounts,
	PostAccount,
	PostAccountPassword,
} from "./routes/root";
import { runScheduledMaintenance } from "./scheduled-run";
import { slugify } from "./slugify";
import {
	classifyByAuthResults,
	isTrustedSelfDomainSender,
	summarizeAuthResults,
} from "./spam-filter";
import {
	clientIp,
	passwordResetThrottleRules,
	retryAfterSeconds,
	throttleKeys,
} from "./throttle";
import type { EmailExplorerOptions, Env, Session } from "./types";

type AppContext = Context<{ Bindings: Env; Variables: { session?: Session } }>;

export { MailboxDO } from "./durableObject";

// Schemas
const MailboxSchema = z.object({
	id: z.string(),
	email: z.string(),
	name: z.string(),
});

const MailboxDetailsSchema = z.object({
	id: z.string(),
	email: z.string(),
	name: z.string(),
	settings: z.record(z.any()),
	/**
	 * Whether the second-stage spam check is still working. Timestamps and a
	 * reason code -- never the API key, and never the upstream error text.
	 * The detail is the one exception and a narrow one: it is the classifier's
	 * own reply, and only when that reply could not be read as a verdict.
	 */
	spamCheck: z
		.object({
			lastSuccessAt: z.string().nullable(),
			lastFailureAt: z.string().nullable(),
			lastFailureReason: z.string().nullable(),
			lastFailureDetail: z.string().nullable(),
		})
		.optional(),
});

const UpdateMailboxRequestSchema = z.object({
	settings: z.record(z.any()),
});

const CreateMailboxRequestSchema = z.object({
	email: z.string().email(),
	name: z.string().min(1),
	settings: z.record(z.any()).optional(),
});

const ErrorResponseSchema = z.object({
	error: z.string(),
});

const ForgotPasswordRequestSchema = z.object({
	email: z.string().email(),
	// Which language to write the recovery mail in. The dashboard sends the
	// locale it is currently displaying, so MAIL_LOCALES has to cover every
	// language the picker offers: a code missing from it is rejected here with
	// a 400 and no mail is sent at all. Anything else -- an older cached page,
	// a direct API call -- falls back (see resolveMailLocale).
	locale: z.enum(MAIL_LOCALES).optional(),
});

const ResetPasswordRequestSchema = z.object({
	token: z.string(),
	newPassword: z.string().min(8),
});

const AppSettingsResponseSchema = z.object({
	auth: z.object({
		enabled: z.boolean(),
		registerEnabled: z.boolean(),
	}),
	accountRecovery: z.object({
		enabled: z.boolean(),
	}),
});

const EmailMetadataSchema = z.object({
	id: z.string(),
	subject: z.string(),
	sender: z.string(),
	recipient: z.string(),
	cc: z.string().nullable().optional(),
	bcc: z.string().nullable().optional(),
	date: z.string(),
	read: z.boolean(),
	starred: z.boolean(),
	in_reply_to: z.string().nullable().optional(),
	email_references: z.string().nullable().optional(),
	thread_id: z.string().nullable().optional(),
});

const AttachmentSchema = z.object({
	id: z.string(),
	filename: z.string(),
	mimetype: z.string(),
	size: z.number(),
	content_id: z.string().optional(),
	disposition: z.string().optional(),
});

const EmailSchema = EmailMetadataSchema.extend({
	body: z.string().nullable(),
	attachments: z.array(AttachmentSchema),
});

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

const UpdateEmailStatusRequestSchema = z.object({
	read: z.boolean().optional(),
	starred: z.boolean().optional(),
});

const MoveEmailRequestSchema = z.object({
	folderId: z.string(),
});

const SpamVerdictRequestSchema = z.object({
	verdict: z.enum(["spam", "not-spam"]),
});

const SuccessResponseSchema = z.object({
	status: z.string(),
});

const FolderSchema = z.object({
	id: z.string(),
	name: z.string(),
	unreadCount: z.number(),
});

const CreateFolderRequestSchema = z.object({
	name: z.string(),
});

const UpdateFolderRequestSchema = z.object({
	name: z.string(),
});

const ContactSchema = z.object({
	id: z.string(),
	name: z.string(),
	email: z.string(),
});

const CreateContactRequestSchema = z.object({
	name: z.string().optional(),
	email: z.string(),
});

const UpdateContactRequestSchema = z.object({
	name: z.string().optional(),
	email: z.string().optional(),
});

// Routes
class GetMailboxes extends OpenAPIRoute {
	schema = {
		summary: "List all mailboxes",
		operationId: "listMailboxes",
		tags: ["Mailboxes"],
		responses: {
			"200": {
				description: "List of mailboxes",
				...contentJson(z.array(MailboxSchema)),
			},
		},
	};

	async handle(c: AppContext) {
		const session = c.get("session");

		const list = await c.env.BUCKET.list({
			prefix: "mailboxes/",
		});
		const allMailboxes = await Promise.all(
			list.objects.map(async (obj) => {
				const id = obj.key.replace("mailboxes/", "").replace(".json", "");
				const settingsObj = await c.env.BUCKET.get(obj.key);
				const settings = settingsObj
					? await settingsObj.json<{ fromName?: string }>()
					: null;
				return {
					id,
					name: settings?.fromName || id,
					email: id,
				};
			}),
		);

		// Before answering, make sure every mailbox that predates the grant
		// model has an owner. This is the screen where a missing grant would
		// first be visible, and now that the administrator bypass below is
		// gone it is the only thing standing between a deployment upgrading
		// into this and an empty mailbox list. Runs once; see legacy-grants.
		await ensureLegacyMailboxGrants(c.env);

		// With authentication switched off there is nobody to ask about, so
		// everything is on show. That is the deployment's own choice.
		if (!session) {
			return c.json(allMailboxes);
		}

		// Otherwise: the mailboxes this person holds. It used to be
		// "everything, if the account carries the admin flag", which reads as
		// one person's own estate only while the deployment holds one person
		// -- a second person made administrator saw the first one's mail.
		const authId = c.env.MAILBOX.idFromName("AUTH");
		const authDO = c.env.MAILBOX.get(authId);
		const allowedMailboxIds = new Set(
			await authDO.getPersonMailboxes(session.userId),
		);

		return c.json(allMailboxes.filter((m) => allowedMailboxIds.has(m.id)));
	}
}

class GetMailbox extends OpenAPIRoute {
	schema = {
		summary: "Get a single mailbox",
		operationId: "getMailbox",
		tags: ["Mailboxes"],
		request: {
			params: z.object({
				mailboxId: z.string(),
			}),
		},
		responses: {
			"200": {
				description: "Mailbox details",
				...contentJson(MailboxDetailsSchema),
			},
			"404": { description: "Not found", ...contentJson(ErrorResponseSchema) },
		},
	};

	async handle(c: AppContext) {
		const data = await this.getValidatedData<typeof this.schema>();
		const { mailboxId } = data.params;
		const key = `mailboxes/${mailboxId}.json`;
		const obj = await c.env.BUCKET.get(key);
		if (!obj) {
			return c.json({ error: "Not found" }, 404);
		}
		const settings = await obj.json<{ fromName?: string }>();

		// How the second-stage spam check has been going. It fails open, so
		// without this the screen shows a configured key whether the check is
		// working or has been rejected on every message for a week.
		const ns = c.env.MAILBOX;
		const spamCheck = await ns
			.get(ns.idFromName(mailboxId))
			.getSpamCheckHealth();

		const response = {
			id: mailboxId,
			name: settings?.fromName || mailboxId,
			email: mailboxId,
			settings: redactMailboxSettings(settings),
			spamCheck,
		};
		return c.json(response);
	}
}

class PutMailbox extends OpenAPIRoute {
	schema = {
		summary: "Update a mailbox",
		operationId: "updateMailbox",
		tags: ["Mailboxes"],
		request: {
			params: z.object({
				mailboxId: z.string(),
			}),
			body: contentJson(UpdateMailboxRequestSchema),
		},
		responses: {
			"200": {
				description: "Updated mailbox",
				...contentJson(MailboxDetailsSchema),
			},
			"404": { description: "Not found", ...contentJson(ErrorResponseSchema) },
		},
	};

	async handle(c: AppContext) {
		const data = await this.getValidatedData<typeof this.schema>();
		const { mailboxId } = data.params;
		const { settings: incomingSettings } = data.body;
		const key = `mailboxes/${mailboxId}.json`;

		const existingObj = await c.env.BUCKET.get(key);
		if (!existingObj) {
			return c.json({ error: "Not found" }, 404);
		}
		const existingSettings = await existingObj.json();

		const mergedSettings = mergeMailboxSettings(
			existingSettings,
			incomingSettings,
		);
		await c.env.BUCKET.put(key, JSON.stringify(mergedSettings));

		const response = {
			id: mailboxId,
			name: mergedSettings?.fromName || mailboxId,
			email: mailboxId,
			settings: redactMailboxSettings(mergedSettings),
		};
		return c.json(response);
	}
}

/** R2 delete accepts up to 1000 keys per call. */
const R2_DELETE_BATCH = 1000;

async function deleteKeysInBatches(
	bucket: R2Bucket,
	keys: string[],
): Promise<void> {
	for (let i = 0; i < keys.length; i += R2_DELETE_BATCH) {
		await bucket.delete(keys.slice(i, i + R2_DELETE_BATCH));
	}
}

/**
 * Whether this session's person holds the mailbox.
 *
 * The single question every mailbox-scoped route asks. It used to be "does
 * this account carry the admin flag", which answered yes for every mailbox in
 * the deployment and so was not a question about this mailbox at all.
 */
export async function personHoldsMailbox(
	env: Env,
	session: Session,
	mailboxId: string,
): Promise<boolean> {
	const authDO = env.MAILBOX.get(env.MAILBOX.idFromName("AUTH"));
	return (await authDO.getPersonMailboxes(session.userId)).includes(mailboxId);
}

/**
 * Removes every R2 object belonging to the given emails: the stored raw
 * message and any attachments.
 *
 * Attachment keys are `attachments/{emailId}/{attachmentId}/{filename}`, so
 * they're found by scanning the prefix once and keeping the ones whose email
 * id belongs to this mailbox -- listing per email instead would burn one
 * subrequest per message.
 */
async function deleteEmailObjects(
	bucket: R2Bucket,
	emailIds: string[],
): Promise<{ rawDeleted: number; attachmentsDeleted: number }> {
	const ids = new Set(emailIds);

	const rawKeys = emailIds.map((id) => `raw/${id}.eml`);
	await deleteKeysInBatches(bucket, rawKeys);

	const attachmentKeys: string[] = [];
	let cursor: string | undefined;
	do {
		const listed = await bucket.list({ prefix: "attachments/", cursor });
		for (const obj of listed.objects) {
			const emailId = obj.key.split("/")[1];
			if (emailId && ids.has(emailId)) attachmentKeys.push(obj.key);
		}
		cursor = listed.truncated ? listed.cursor : undefined;
	} while (cursor);
	await deleteKeysInBatches(bucket, attachmentKeys);

	return {
		rawDeleted: rawKeys.length,
		attachmentsDeleted: attachmentKeys.length,
	};
}

class DeleteMailbox extends OpenAPIRoute {
	schema = {
		summary: "Delete a mailbox",
		operationId: "deleteMailbox",
		tags: ["Mailboxes"],
		request: {
			params: z.object({
				mailboxId: z.string(),
			}),
			query: z.object({
				// Opt-in: also destroy the stored mail. Without it the mailbox
				// is only unlisted, exactly as before, and the messages stay
				// recoverable by recreating the mailbox.
				purge: z.enum(["true", "false"]).optional(),
			}),
		},
		responses: {
			"204": { description: "Deleted successfully" },
			"404": { description: "Not found", ...contentJson(ErrorResponseSchema) },
			"423": {
				description: "Mailbox is protected from deletion",
				...contentJson(ErrorResponseSchema),
			},
		},
	};

	async handle(c: AppContext) {
		const data = await this.getValidatedData<typeof this.schema>();
		const { mailboxId } = data.params;
		const purge = data.query?.purge === "true";
		const key = `mailboxes/${mailboxId}.json`;

		const obj = await c.env.BUCKET.get(key);
		if (!obj) {
			return c.json({ error: "Not found" }, 404);
		}

		const settings = await obj.json<Record<string, any>>();
		if (isDeletionLocked(settings)) {
			return c.json({ error: "Mailbox is protected from deletion" }, 423);
		}

		if (purge) {
			const ns = c.env.MAILBOX;
			const stub = ns.get(ns.idFromName(mailboxId));

			// Collect the ids first: destroying the DO takes the only record
			// of which R2 objects belonged to this mailbox with it.
			const emailIds = await stub.listAllEmailIds();
			await deleteEmailObjects(c.env.BUCKET, emailIds);
			await stub.destroyMailbox();

			const authStub = ns.get(ns.idFromName("AUTH"));
			await authStub.revokeAllMailboxAccess(mailboxId);
		}

		await c.env.BUCKET.delete(key);

		return c.body(null, 204);
	}
}

class PostMailbox extends OpenAPIRoute {
	schema = {
		summary: "Create a new mailbox",
		operationId: "createMailbox",
		tags: ["Mailboxes"],
		request: {
			body: contentJson(CreateMailboxRequestSchema),
		},
		responses: {
			"201": {
				description: "Mailbox created successfully",
				...contentJson(MailboxDetailsSchema),
			},
			"400": {
				description: "Bad request",
				...contentJson(ErrorResponseSchema),
			},
			"409": {
				description: "Mailbox already exists",
				...contentJson(ErrorResponseSchema),
			},
		},
	};

	async handle(c: AppContext) {
		const data = await this.getValidatedData<typeof this.schema>();
		const { email, name, settings } = data.body;

		const key = `mailboxes/${email}.json`;

		// Check if mailbox already exists
		const existing = await c.env.BUCKET.head(key);
		if (existing) {
			return c.json({ error: "Mailbox already exists" }, 409);
		}

		// Default settings
		const defaultSettings = {
			fromName: name,
			// New mailboxes start protected; deleting one is a deliberate
			// two-step (unlock, then delete). See isDeletionLocked.
			deletionLocked: true,
			forwarding: {
				enabled: false,
				email: "",
			},
			signature: {
				enabled: false,
				text: "",
			},
			autoReply: {
				enabled: false,
				subject: "",
				message: "",
			},
		};

		const finalSettings = { ...defaultSettings, ...settings };

		// Save mailbox settings to R2
		await c.env.BUCKET.put(key, JSON.stringify(finalSettings));

		// Initialize the durable object for this mailbox
		const ns = c.env.MAILBOX;
		const id = ns.idFromName(email);
		const stub = ns.get(id);

		// Trigger first run of the durable object to initialize database
		await stub.getFolders();

		// Whoever registered it holds it -- the person, not the login, so it
		// stays theirs when they change which address they sign in with.
		// Without this the mailbox belongs to nobody and is invisible on every
		// screen: a mailbox created and lost in the same click.
		const session = c.get("session");
		if (session) {
			const authDO = c.env.MAILBOX.get(c.env.MAILBOX.idFromName("AUTH"));
			await authDO.giveMailboxToPersonOf(session.userId, email);
		}

		const response = {
			id: email,
			email: email,
			name: name,
			settings: redactMailboxSettings(finalSettings),
		};

		return c.json(response, 201);
	}
}

class GetEmails extends OpenAPIRoute {
	schema = {
		summary: "List emails in a mailbox",
		operationId: "listEmails",
		tags: ["Emails"],
		request: {
			params: z.object({
				mailboxId: z.string(),
			}),
			query: z.object({
				folder: z.string().optional(),
				page: z.number().int().optional(),
				limit: z.number().int().optional(),
				sortColumn: z
					.enum([
						"id",
						"subject",
						"sender",
						"recipient",
						"date",
						"read",
						"starred",
					])
					.optional(),
				sortDirection: z.enum(["ASC", "DESC"]).optional(),
				filter: z.string().optional(),
			}),
		},
		responses: {
			"200": {
				description: "List of email metadata",
				...contentJson(z.array(EmailMetadataSchema)),
			},
		},
	};

	async handle(c: AppContext) {
		const data = await this.getValidatedData<typeof this.schema>();
		const { mailboxId } = data.params;
		const { folder, page, limit, sortColumn, sortDirection } = data.query;

		const key = `mailboxes/${mailboxId}.json`;
		const obj = await c.env.BUCKET.head(key);
		if (!obj) {
			return c.json({ error: "Not found" }, 404);
		}

		const ns = c.env.MAILBOX;
		const id = ns.idFromName(mailboxId);
		const stub = ns.get(id);

		const emails = await stub.getEmails({
			folder,
			page,
			limit,
			sortColumn,
			sortDirection,
		});

		return c.json(emails);
	}
}

class PostEmail extends OpenAPIRoute {
	schema = {
		summary: "Send an email",
		operationId: "sendEmail",
		tags: ["Emails"],
		request: {
			params: z.object({
				mailboxId: z.string(),
			}),
			body: contentJson(SendEmailRequestSchema),
		},
		responses: {
			"201": {
				description: "Email sent successfully",
				...contentJson(SendEmailResponseSchema),
			},
			"400": {
				description: "Bad request",
				...contentJson(ErrorResponseSchema),
			},
		},
	};

	async handle(c: AppContext) {
		const data = await this.getValidatedData<typeof this.schema>();
		const { mailboxId } = data.params;
		const {
			to,
			cc,
			bcc,
			from,
			subject,
			html,
			text,
			attachments,
			in_reply_to,
			references,
			thread_id,
		} = data.body;

		const key = `mailboxes/${mailboxId}.json`;
		const obj = await c.env.BUCKET.head(key);
		if (!obj) {
			return c.json({ error: "Not found" }, 404);
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

		const ns = c.env.MAILBOX;
		const id = ns.idFromName(mailboxId);
		const stub = ns.get(id);

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
				in_reply_to: in_reply_to || null,
				email_references: references ? JSON.stringify(references) : null,
				thread_id: thread_id || in_reply_to || messageId,
			},
			attachmentData,
		);

		return c.json({ id: messageId, status: "sent" }, 201);
	}
}

class GetEmail extends OpenAPIRoute {
	schema = {
		summary: "Get a single email",
		operationId: "getEmail",
		tags: ["Emails"],
		request: {
			params: z.object({
				mailboxId: z.string(),
				id: z.string(),
			}),
		},
		responses: {
			"200": { description: "Email details", ...contentJson(EmailSchema) },
			"404": { description: "Not found", ...contentJson(ErrorResponseSchema) },
		},
	};

	async handle(c: AppContext) {
		const data = await this.getValidatedData<typeof this.schema>();
		const { mailboxId, id } = data.params;

		const key = `mailboxes/${mailboxId}.json`;
		const obj = await c.env.BUCKET.head(key);
		if (!obj) {
			return c.json({ error: "Not found" }, 404);
		}

		const ns = c.env.MAILBOX;
		const doId = ns.idFromName(mailboxId);
		const stub = ns.get(doId);

		const email = await stub.getEmail(id);

		if (!email) {
			return c.json({ error: "Email not found" }, 404);
		}

		return c.json(email);
	}
}

class PutEmail extends OpenAPIRoute {
	schema = {
		summary: "Update an email",
		operationId: "updateEmail",
		tags: ["Emails"],
		request: {
			params: z.object({
				mailboxId: z.string(),
				id: z.string(),
			}),
			body: contentJson(UpdateEmailStatusRequestSchema),
		},
		responses: {
			"200": {
				description: "Updated email metadata",
				...contentJson(EmailMetadataSchema),
			},
			"404": { description: "Not found", ...contentJson(ErrorResponseSchema) },
		},
	};

	async handle(c: AppContext) {
		const data = await this.getValidatedData<typeof this.schema>();
		const { mailboxId, id } = data.params;
		const { read, starred } = data.body;

		const key = `mailboxes/${mailboxId}.json`;
		const obj = await c.env.BUCKET.head(key);
		if (!obj) {
			return c.json({ error: "Not found" }, 404);
		}

		const ns = c.env.MAILBOX;
		const doId = ns.idFromName(mailboxId);
		const stub = ns.get(doId);

		const email = await stub.updateEmail(id, { read, starred });

		if (!email) {
			return c.json({ error: "Email not found" }, 404);
		}

		if (read === true) {
			await dismissEmailNotification(c.env, mailboxId, id);
		}

		return c.json(email);
	}
}

class DeleteEmail extends OpenAPIRoute {
	schema = {
		summary: "Delete an email",
		operationId: "deleteEmail",
		tags: ["Emails"],
		request: {
			params: z.object({
				mailboxId: z.string(),
				id: z.string(),
			}),
		},
		responses: {
			"204": { description: "Deleted successfully" },
			"404": { description: "Not found", ...contentJson(ErrorResponseSchema) },
		},
	};

	async handle(c: AppContext) {
		const data = await this.getValidatedData<typeof this.schema>();
		const { mailboxId, id } = data.params;

		const key = `mailboxes/${mailboxId}.json`;
		const obj = await c.env.BUCKET.head(key);
		if (!obj) {
			return c.json({ error: "Not found" }, 404);
		}

		const ns = c.env.MAILBOX;
		const doId = ns.idFromName(mailboxId);
		const stub = ns.get(doId);

		const attachments = await stub.deleteEmail(id);

		if (attachments.length > 0) {
			const keys = attachments.map(
				(att) => `attachments/${id}/${att.id}/${att.filename}`,
			);
			await c.env.BUCKET.delete(keys);
		}
		await c.env.BUCKET.delete(`raw/${id}.eml`);

		// The message is gone for good, so a notification pointing at it would
		// only lead nowhere. Clear it from every device.
		await dismissEmailNotification(c.env, mailboxId, id);

		return c.body(null, 204);
	}
}

class PostMoveEmail extends OpenAPIRoute {
	schema = {
		summary: "Move an email to a folder",
		operationId: "moveEmail",
		tags: ["Emails"],
		request: {
			params: z.object({
				mailboxId: z.string(),
				id: z.string(),
			}),
			body: contentJson(MoveEmailRequestSchema),
		},
		responses: {
			"200": {
				description: "Moved successfully",
				...contentJson(SuccessResponseSchema),
			},
			"400": {
				description: "Bad request",
				...contentJson(ErrorResponseSchema),
			},
			"404": { description: "Not found", ...contentJson(ErrorResponseSchema) },
		},
	};

	async handle(c: AppContext) {
		const data = await this.getValidatedData<typeof this.schema>();
		const { mailboxId, id } = data.params;
		const { folderId } = data.body;

		const key = `mailboxes/${mailboxId}.json`;
		const obj = await c.env.BUCKET.head(key);
		if (!obj) {
			return c.json({ error: "Not found" }, 404);
		}

		const ns = c.env.MAILBOX;
		const doId = ns.idFromName(mailboxId);
		const stub = ns.get(doId);

		const success = await stub.moveEmail(id, folderId);

		if (!success) {
			return c.json({ error: "Folder not found" }, 400);
		}

		// Binning or filing something as spam means the user has dealt with it,
		// so the notification should go even though the mail stays unread.
		// Other destinations (archive, custom folders) are left alone for now.
		if (folderId === "trash" || folderId === "spam") {
			await dismissEmailNotification(c.env, mailboxId, id);
		}

		return c.json({ status: "moved" });
	}
}

class PostEmailSpamVerdict extends OpenAPIRoute {
	schema = {
		summary:
			"Mark an email's sender as spam or not-spam, and move the email accordingly",
		operationId: "setEmailSpamVerdict",
		tags: ["Emails"],
		request: {
			params: z.object({
				mailboxId: z.string(),
				id: z.string(),
			}),
			body: contentJson(SpamVerdictRequestSchema),
		},
		responses: {
			"200": {
				description: "Verdict recorded and email moved",
				...contentJson(SuccessResponseSchema),
			},
			"404": { description: "Not found", ...contentJson(ErrorResponseSchema) },
		},
	};

	async handle(c: AppContext) {
		const data = await this.getValidatedData<typeof this.schema>();
		const { mailboxId, id } = data.params;
		const { verdict } = data.body;

		const ns = c.env.MAILBOX;
		const doId = ns.idFromName(mailboxId);
		const stub = ns.get(doId);

		const email = (await stub.getEmail(id)) as any;
		if (!email) {
			return c.json({ error: "Email not found" }, 404);
		}

		const senderVerdict = verdict === "spam" ? "spam" : "inbox";
		await recordSenderVerdict(c.env, mailboxId, email.sender, senderVerdict);
		await stub.moveEmail(id, senderVerdict);

		if (verdict === "spam") {
			// The mail has been dealt with, so drop the notification still
			// sitting on the phone. Read state is deliberately left alone: it
			// stays unread in the spam folder.
			await dismissEmailNotification(c.env, mailboxId, id);
		}

		return c.json({ status: "moved" });
	}
}

class GetFolders extends OpenAPIRoute {
	schema = {
		summary: "List all folders",
		operationId: "listFolders",
		tags: ["Folders"],
		request: {
			params: z.object({
				mailboxId: z.string(),
			}),
		},
		responses: {
			"200": {
				description: "List of folders",
				...contentJson(z.array(FolderSchema)),
			},
		},
	};

	async handle(c: AppContext) {
		const data = await this.getValidatedData<typeof this.schema>();
		const { mailboxId } = data.params;

		const key = `mailboxes/${mailboxId}.json`;
		const obj = await c.env.BUCKET.head(key);
		if (!obj) {
			return c.json({ error: "Not found" }, 404);
		}

		const ns = c.env.MAILBOX;
		const id = ns.idFromName(mailboxId);
		const stub = ns.get(id);

		const folders = await stub.getFolders();

		return c.json(folders);
	}
}

class PostFolder extends OpenAPIRoute {
	schema = {
		summary: "Create a folder",
		operationId: "createFolder",
		tags: ["Folders"],
		request: {
			params: z.object({
				mailboxId: z.string(),
			}),
			body: contentJson(CreateFolderRequestSchema),
		},
		responses: {
			"201": { description: "Folder created", ...contentJson(FolderSchema) },
			"400": {
				description: "Bad request",
				...contentJson(ErrorResponseSchema),
			},
		},
	};

	async handle(c: AppContext) {
		const data = await this.getValidatedData<typeof this.schema>();
		const { mailboxId } = data.params;
		const { name } = data.body;

		const key = `mailboxes/${mailboxId}.json`;
		const obj = await c.env.BUCKET.head(key);
		if (!obj) {
			return c.json({ error: "Not found" }, 404);
		}

		const ns = c.env.MAILBOX;
		const doId = ns.idFromName(mailboxId);
		const stub = ns.get(doId);

		const slug = slugify(name);
		const newFolder = await stub.createFolder(slug, name);

		if (!newFolder) {
			return c.json({ error: "Folder with this name already exists" }, 409);
		}

		return c.json(newFolder, 201);
	}
}

class PutFolder extends OpenAPIRoute {
	schema = {
		summary: "Update a folder",
		operationId: "updateFolder",
		tags: ["Folders"],
		request: {
			params: z.object({
				mailboxId: z.string(),
				id: z.string(),
			}),
			body: contentJson(UpdateFolderRequestSchema),
		},
		responses: {
			"200": { description: "Updated folder", ...contentJson(FolderSchema) },
			"404": { description: "Not found", ...contentJson(ErrorResponseSchema) },
		},
	};

	async handle(c: AppContext) {
		const data = await this.getValidatedData<typeof this.schema>();
		const { mailboxId, id } = data.params;
		const { name } = data.body;

		const key = `mailboxes/${mailboxId}.json`;
		const obj = await c.env.BUCKET.head(key);
		if (!obj) {
			return c.json({ error: "Not found" }, 404);
		}

		const ns = c.env.MAILBOX;
		const doId = ns.idFromName(mailboxId);
		const stub = ns.get(doId);

		const updatedFolder = await stub.updateFolder(id, name);

		if (!updatedFolder) {
			return c.json({ error: "Folder not found" }, 404);
		}

		return c.json(updatedFolder);
	}
}

class DeleteFolder extends OpenAPIRoute {
	schema = {
		summary: "Delete a folder",
		operationId: "deleteFolder",
		tags: ["Folders"],
		request: {
			params: z.object({
				mailboxId: z.string(),
				id: z.string(),
			}),
		},
		responses: {
			"204": { description: "Deleted successfully" },
			"400": {
				description: "Bad request",
				...contentJson(ErrorResponseSchema),
			},
			"404": { description: "Not found", ...contentJson(ErrorResponseSchema) },
		},
	};

	async handle(c: AppContext) {
		const data = await this.getValidatedData<typeof this.schema>();
		const { mailboxId, id } = data.params;

		const key = `mailboxes/${mailboxId}.json`;
		const obj = await c.env.BUCKET.head(key);
		if (!obj) {
			return c.json({ error: "Not found" }, 404);
		}

		const ns = c.env.MAILBOX;
		const doId = ns.idFromName(mailboxId);
		const stub = ns.get(doId);

		const success = await stub.deleteFolder(id);

		if (!success) {
			return c.json({ error: "Folder not found or cannot be deleted" }, 400);
		}

		return c.body(null, 204);
	}
}

class GetContacts extends OpenAPIRoute {
	schema = {
		summary: "List all contacts",
		operationId: "listContacts",
		tags: ["Contacts"],
		request: {
			params: z.object({
				mailboxId: z.string(),
			}),
		},
		responses: {
			"200": {
				description: "List of contacts",
				...contentJson(z.array(ContactSchema)),
			},
		},
	};

	async handle(c: AppContext) {
		const data = await this.getValidatedData<typeof this.schema>();
		const { mailboxId } = data.params;

		const key = `mailboxes/${mailboxId}.json`;
		const obj = await c.env.BUCKET.head(key);
		if (!obj) {
			return c.json({ error: "Not found" }, 404);
		}

		const ns = c.env.MAILBOX;
		const id = ns.idFromName(mailboxId);
		const stub = ns.get(id);

		const contacts = await stub.getContacts();

		return c.json(contacts);
	}
}

class PostContact extends OpenAPIRoute {
	schema = {
		summary: "Create a contact",
		operationId: "createContact",
		tags: ["Contacts"],
		request: {
			params: z.object({
				mailboxId: z.string(),
			}),
			body: contentJson(CreateContactRequestSchema),
		},
		responses: {
			"201": { description: "Contact created", ...contentJson(ContactSchema) },
			"400": {
				description: "Bad request",
				...contentJson(ErrorResponseSchema),
			},
		},
	};

	async handle(c: AppContext) {
		const data = await this.getValidatedData<typeof this.schema>();
		const { mailboxId } = data.params;
		const { name, email } = data.body;

		const key = `mailboxes/${mailboxId}.json`;
		const obj = await c.env.BUCKET.head(key);
		if (!obj) {
			return c.json({ error: "Not found" }, 404);
		}

		const ns = c.env.MAILBOX;
		const id = ns.idFromName(mailboxId);
		const stub = ns.get(id);

		const newContact = await stub.createContact({ name, email });

		return c.json(newContact, 201);
	}
}

class PutContact extends OpenAPIRoute {
	schema = {
		summary: "Update a contact",
		operationId: "updateContact",
		tags: ["Contacts"],
		request: {
			params: z.object({
				mailboxId: z.string(),
				id: z.string(),
			}),
			body: contentJson(UpdateContactRequestSchema),
		},
		responses: {
			"200": { description: "Updated contact", ...contentJson(ContactSchema) },
			"404": { description: "Not found", ...contentJson(ErrorResponseSchema) },
		},
	};

	async handle(c: AppContext) {
		const data = await this.getValidatedData<typeof this.schema>();
		const { mailboxId, id } = data.params;
		const { name, email } = data.body;

		const key = `mailboxes/${mailboxId}.json`;
		const obj = await c.env.BUCKET.head(key);
		if (!obj) {
			return c.json({ error: "Not found" }, 404);
		}

		const ns = c.env.MAILBOX;
		const doId = ns.idFromName(mailboxId);
		const stub = ns.get(doId);

		const updatedContact = await stub.updateContact(Number.parseInt(id, 10), {
			name,
			email,
		});

		if (!updatedContact) {
			return c.json({ error: "Contact not found" }, 404);
		}

		return c.json(updatedContact);
	}
}

class DeleteContact extends OpenAPIRoute {
	schema = {
		summary: "Delete a contact",
		operationId: "deleteContact",
		tags: ["Contacts"],
		request: {
			params: z.object({
				mailboxId: z.string(),
				id: z.string(),
			}),
		},
		responses: {
			"204": { description: "Deleted successfully" },
			"404": { description: "Not found", ...contentJson(ErrorResponseSchema) },
		},
	};

	async handle(c: AppContext) {
		const data = await this.getValidatedData<typeof this.schema>();
		const { mailboxId, id } = data.params;

		const key = `mailboxes/${mailboxId}.json`;
		const obj = await c.env.BUCKET.head(key);
		if (!obj) {
			return c.json({ error: "Not found" }, 404);
		}

		const ns = c.env.MAILBOX;
		const doId = ns.idFromName(mailboxId);
		const stub = ns.get(doId);

		stub.deleteContact(Number.parseInt(id, 10));

		return c.body(null, 204);
	}
}

class GetSearch extends OpenAPIRoute {
	schema = {
		summary: "Search for emails",
		operationId: "searchEmails",
		tags: ["Search"],
		request: {
			params: z.object({
				mailboxId: z.string(),
			}),
			query: z.object({
				query: z.string(),
				folder: z.string().optional(),
				from: z.string().optional(),
				to: z.string().optional(),
				date_start: z.string().datetime().optional(),
				date_end: z.string().datetime().optional(),
			}),
		},
		responses: {
			"200": {
				description: "List of matching emails",
				...contentJson(z.array(EmailMetadataSchema)),
			},
		},
	};

	async handle(c: AppContext) {
		const data = await this.getValidatedData<typeof this.schema>();
		const { mailboxId } = data.params;
		const { query, folder, from, to, date_start, date_end } = data.query;

		const key = `mailboxes/${mailboxId}.json`;
		const obj = await c.env.BUCKET.head(key);
		if (!obj) {
			return c.json({ error: "Not found" }, 404);
		}

		const ns = c.env.MAILBOX;
		const id = ns.idFromName(mailboxId);
		const stub = ns.get(id);

		const emails = await stub.searchEmails({
			query,
			folder,
			from,
			to,
			date_start,
			date_end,
		});

		return c.json(emails);
	}
}

class GetAttachment extends OpenAPIRoute {
	schema = {
		summary: "Get an email attachment",
		operationId: "getAttachment",
		tags: ["Emails"],
		request: {
			params: z.object({
				mailboxId: z.string(),
				emailId: z.string(),
				attachmentId: z.string(),
			}),
		},
		responses: {
			"200": {
				description: "Attachment file",
				content: {
					"application/octet-stream": {
						schema: z.string().openapi({ format: "binary" }),
					},
				},
			},
			"404": { description: "Not found", ...contentJson(ErrorResponseSchema) },
		},
	};

	async handle(c: AppContext) {
		const data = await this.getValidatedData<typeof this.schema>();
		const { mailboxId, emailId, attachmentId } = data.params ?? {};

		const key = `mailboxes/${mailboxId}.json`;
		const obj = await c.env.BUCKET.head(key);
		if (!obj) {
			return c.json({ error: "Not found" }, 404);
		}

		const ns = c.env.MAILBOX;
		const doId = ns.idFromName(mailboxId);
		const stub = ns.get(doId);

		const attachment = await stub.getAttachment(attachmentId);

		if (!attachment) {
			return c.json({ error: "Attachment not found" }, 404);
		}

		const attachmentKey = `attachments/${emailId}/${attachmentId}/${attachment.filename}`;
		const attachmentObj = await c.env.BUCKET.get(attachmentKey);

		if (!attachmentObj) {
			return c.json({ error: "Attachment file not found" }, 404);
		}

		const headers = new Headers();
		headers.set("Content-Type", attachment.mimetype);
		headers.set(
			"Content-Disposition",
			`attachment; filename="${attachment.filename}"`,
		);

		return new Response(attachmentObj.body, {
			headers,
		});
	}
}

class GetEmailSource extends OpenAPIRoute {
	schema = {
		summary: "Get the raw original message source (headers included)",
		operationId: "getEmailSource",
		tags: ["Emails"],
		request: {
			params: z.object({
				mailboxId: z.string(),
				emailId: z.string(),
			}),
		},
		responses: {
			"200": {
				description: "Raw email source",
				content: {
					"text/plain": {
						schema: z.string(),
					},
				},
			},
			"404": { description: "Not found", ...contentJson(ErrorResponseSchema) },
		},
	};

	async handle(c: AppContext) {
		const data = await this.getValidatedData<typeof this.schema>();
		const { mailboxId, emailId } = data.params ?? {};

		const key = `mailboxes/${mailboxId}.json`;
		const obj = await c.env.BUCKET.head(key);
		if (!obj) {
			return c.json({ error: "Not found" }, 404);
		}

		const rawObj = await c.env.BUCKET.get(`raw/${emailId}.eml`);
		if (!rawObj) {
			return c.json({ error: "Original source not available" }, 404);
		}

		const headers = new Headers();
		headers.set("Content-Type", "text/plain; charset=utf-8");
		headers.set("Content-Disposition", `inline; filename="${emailId}.eml"`);

		return new Response(rawObj.body, { headers });
	}
}

class GetMailboxExport extends OpenAPIRoute {
	schema = {
		summary: "Download the whole mailbox as an mbox file",
		operationId: "exportMailbox",
		tags: ["Mailboxes"],
		request: {
			params: z.object({ mailboxId: z.string() }),
		},
		responses: {
			"200": {
				description: "mbox archive",
				content: {
					"application/mbox": { schema: z.string() },
				},
			},
			"404": {
				description: "Mailbox not found",
				...contentJson(ErrorResponseSchema),
			},
		},
	};

	async handle(c: AppContext) {
		const data = await this.getValidatedData<typeof this.schema>();
		const { mailboxId } = data.params ?? {};

		if (!(await c.env.BUCKET.head(`mailboxes/${mailboxId}.json`))) {
			return c.json({ error: "Not found" }, 404);
		}

		const stub = c.env.MAILBOX.get(c.env.MAILBOX.idFromName(mailboxId));
		const ids = await stub.listEmailIdsByDate();

		// Read once, up front: a folder the user made has a uuid for an id, so
		// the row alone cannot say where the message sat in a way that means
		// anything after a restore. Five to a few dozen rows, so holding the
		// map costs nothing next to streaming the mail itself.
		const folderNames = new Map<string, string>();
		for (const folder of await stub.getFolders()) {
			folderNames.set(String(folder.id), String(folder.name));
		}

		// Streamed one message at a time rather than assembled first: a
		// mailbox can be far larger than a Worker may hold in memory, and the
		// download starts immediately instead of after the last message.
		const encoder = new TextEncoder();
		let index = 0;
		const body = new ReadableStream({
			async pull(controller) {
				if (index >= ids.length) {
					controller.close();
					return;
				}
				const email = await stub.getEmail(ids[index++]);
				if (!email) return;
				const folderId = String(
					(email as { folder_id?: string }).folder_id ?? "inbox",
				);
				controller.enqueue(
					encoder.encode(
						await renderMboxEntry(
							c.env,
							email as never,
							folderNames.get(folderId) ?? folderId,
						),
					),
				);
			},
		});

		const stamp = new Date().toISOString().slice(0, 10);
		return new Response(body, {
			headers: {
				"Content-Type": "application/mbox; charset=utf-8",
				"Content-Disposition": `attachment; filename="${mailboxId}-${stamp}.mbox"`,
			},
		});
	}
}

const StoredBackupSchema = z.object({
	name: z.string(),
	at: z.string(),
	size: z.number(),
});

const SpamFilterCheckSchema = z.object({
	ok: z.boolean(),
	failure: z.string().optional(),
	detail: z.string().optional(),
});

/**
 * Puts the stored key to the API once, now, and says what came back.
 *
 * Without this the only thing that exercises a key is inbound mail, so the
 * answer to "is this key working?" arrives whenever the next message does --
 * which, on a quiet mailbox, is hours. Saving a key that the API refuses
 * therefore looks exactly like saving one that works, and the screen goes on
 * showing a green badge until something happens to arrive.
 *
 * It is the real call: same model, same headers, same request shape, so a
 * refusal here is the refusal mail would have met. Two things it cannot
 * promise. It leaves from wherever this request landed, and inbound mail
 * leaves from wherever that message landed, so a refusal aimed at one address
 * and not another will not necessarily show up in both. And it says nothing
 * about the next call -- only about this one.
 *
 * Deliberately not recorded in spam_check_health: that line is the history of
 * what happened to actual mail, and writing a manual test into it would clear
 * a standing warning without a single message having been classified.
 */
class PostSpamFilterCheck extends OpenAPIRoute {
	schema = {
		summary: "Check the stored Claude API key against the API",
		operationId: "checkSpamFilterKey",
		tags: ["Mailboxes"],
		request: { params: z.object({ mailboxId: z.string() }) },
		responses: {
			"200": {
				description: "What the API said",
				...contentJson(SpamFilterCheckSchema),
			},
			"404": {
				description: "Mailbox not found, or no key stored",
				...contentJson(ErrorResponseSchema),
			},
		},
	};

	async handle(c: AppContext) {
		const data = await this.getValidatedData<typeof this.schema>();
		const { mailboxId } = data.params ?? {};

		const apiKey = await getClaudeApiKey(c.env, mailboxId);
		if (!apiKey) {
			return c.json({ error: "Not found" }, 404);
		}

		// A message of the shape the classifier is given, standing in for one.
		// Its verdict is thrown away -- what is being tested is whether the
		// call is allowed to happen at all.
		const result = await classifyWithClaude({
			apiKey,
			subject: "Test",
			from: "postmaster@example.com",
			text: "This message exists only to check that the key works.",
		});

		return c.json({
			ok: !result.failure,
			failure: result.failure,
			detail: result.detail,
		});
	}
}

/**
 * The archives kept for this mailbox, newest first.
 *
 * There is no companion route that deletes one, and that is the point:
 * rotation inside the scheduled run is the only thing that removes a backup.
 * Someone who takes over an account here can destroy the mail but not the
 * copies of it. Adding a delete endpoint would quietly undo that.
 */
class GetMailboxBackups extends OpenAPIRoute {
	schema = {
		summary: "List the automatic backups kept for a mailbox",
		operationId: "listMailboxBackups",
		tags: ["Mailboxes"],
		request: { params: z.object({ mailboxId: z.string() }) },
		responses: {
			"200": {
				description: "Stored backups, newest first",
				...contentJson(z.array(StoredBackupSchema)),
			},
			"404": {
				description: "Mailbox not found",
				...contentJson(ErrorResponseSchema),
			},
		},
	};

	async handle(c: AppContext) {
		const data = await this.getValidatedData<typeof this.schema>();
		const { mailboxId } = data.params ?? {};

		if (!(await c.env.BUCKET.head(`mailboxes/${mailboxId}.json`))) {
			return c.json({ error: "Not found" }, 404);
		}

		return c.json(await listBackups(c.env, mailboxId));
	}
}

class GetMailboxBackup extends OpenAPIRoute {
	schema = {
		summary: "Download one stored backup",
		operationId: "getMailboxBackup",
		tags: ["Mailboxes"],
		request: {
			params: z.object({ mailboxId: z.string(), name: z.string() }),
		},
		responses: {
			"200": {
				description: "The archive",
				content: { "application/mbox": { schema: z.string() } },
			},
			"404": {
				description: "No such backup",
				...contentJson(ErrorResponseSchema),
			},
		},
	};

	async handle(c: AppContext) {
		const data = await this.getValidatedData<typeof this.schema>();
		const { mailboxId, name } = data.params ?? {};

		// A sanity check on the name, not the thing that makes this safe: R2
		// keys are literal, so a "../" in one is part of the key rather than a
		// step up, and the router will not match a path parameter across a
		// slash anyway. Both were measured rather than assumed. The check
		// stays because it costs nothing and says what a name is allowed to
		// be, but it is not load-bearing.
		if (!/^[\w.-]+\.mbox$/.test(name)) {
			return c.json({ error: "Not found" }, 404);
		}

		const object = await c.env.BUCKET.get(
			`${backupKeyPrefix(mailboxId)}${name}`,
		);
		if (!object) {
			return c.json({ error: "Not found" }, 404);
		}

		return new Response(object.body, {
			headers: {
				"Content-Type": "application/mbox; charset=utf-8",
				"Content-Disposition": `attachment; filename="${mailboxId}-${name}"`,
			},
		});
	}
}

const PutEmailSourceRequestSchema = z.object({
	rawEmailBase64: z.string(),
});

class PutEmailSource extends OpenAPIRoute {
	schema = {
		summary:
			"Attach the raw original message source to an already-imported email (admin only, backfill)",
		operationId: "putEmailSource",
		tags: ["Admin"],
		request: {
			params: z.object({
				mailboxId: z.string(),
				emailId: z.string(),
			}),
			body: contentJson(PutEmailSourceRequestSchema),
		},
		responses: {
			"204": { description: "Source stored" },
			"400": {
				description: "Bad request",
				...contentJson(ErrorResponseSchema),
			},
			"401": {
				description: "Unauthorized",
				...contentJson(ErrorResponseSchema),
			},
			"403": {
				description: "Forbidden - Admin privileges required",
				...contentJson(ErrorResponseSchema),
			},
			"404": { description: "Not found", ...contentJson(ErrorResponseSchema) },
		},
	};

	async handle(c: AppContext) {
		const session = c.get("session");
		if (!session) {
			return c.json({ error: "Unauthorized" }, 401);
		}
		const data = await this.getValidatedData<typeof this.schema>();
		const { mailboxId, emailId } = data.params ?? {};
		if (!(await personHoldsMailbox(c.env, session, mailboxId))) {
			return c.json({ error: "You don't have access to this mailbox" }, 403);
		}
		const { rawEmailBase64 } = data.body;

		const key = `mailboxes/${mailboxId}.json`;
		const obj = await c.env.BUCKET.head(key);
		if (!obj) {
			return c.json({ error: "Not found" }, 404);
		}

		const ns = c.env.MAILBOX;
		const doId = ns.idFromName(mailboxId);
		const stub = ns.get(doId);

		const email = await stub.getEmail(emailId);
		if (!email) {
			return c.json({ error: "Email not found" }, 404);
		}

		let rawEmail: Uint8Array;
		try {
			rawEmail = Uint8Array.from(atob(rawEmailBase64), (ch) =>
				ch.charCodeAt(0),
			);
		} catch {
			return c.json({ error: "rawEmailBase64 is not valid base64" }, 400);
		}

		await c.env.BUCKET.put(`raw/${emailId}.eml`, rawEmail);

		return c.body(null, 204);
	}
}

class PostForgotPassword extends OpenAPIRoute {
	schema = {
		summary: "Request password reset email",
		operationId: "forgotPassword",
		tags: ["Auth"],
		request: {
			body: contentJson(ForgotPasswordRequestSchema),
		},
		responses: {
			"200": {
				description: "Password reset email sent",
				...contentJson(SuccessResponseSchema),
			},
			"400": {
				description: "Bad request",
				...contentJson(ErrorResponseSchema),
			},
			"429": {
				description: "Too many requests",
				...contentJson(ErrorResponseSchema),
			},
			"503": {
				description: "Account recovery disabled",
				...contentJson(ErrorResponseSchema),
			},
		},
	};

	async handle(c: AppContext) {
		const fromEmail = recoveryFromEmail(c.env);
		if (!fromEmail) {
			return c.json({ error: "Account recovery is not enabled" }, 503);
		}

		const data = await this.getValidatedData<typeof this.schema>();
		const { email, locale } = data.body;

		const ns = c.env.MAILBOX;
		const authId = ns.idFromName("AUTH");
		const authStub = ns.get(authId);

		const rules = passwordResetThrottleRules(email, clientIp(c.req.raw));
		const retryAfterMs = await authStub.throttleRetryAfter(throttleKeys(rules));
		if (retryAfterMs > 0) {
			c.header("Retry-After", String(retryAfterSeconds(retryAfterMs)));
			return c.json({ error: "Too many requests" }, 429);
		}
		// Counted before the lookup, so the limit applies to addresses that
		// exist and addresses that don't alike -- otherwise the rate at which
		// requests are accepted would itself answer "does this account exist".
		await authStub.throttleRecord(rules);

		const user = await authStub.getUserByEmail(email);
		if (!user) {
			// Deliberately the same response an existing address gets. Telling
			// the caller which addresses have accounts hands an attacker the
			// list of names worth guessing passwords for.
			return c.json({ status: "Password reset email sent" });
		}

		// Generate reset token (valid for 1 hour)
		const token = crypto.randomUUID();
		const expiresAt = Date.now() + 3600000; // 1 hour

		// Store token in R2
		const tokenKey = `recovery-tokens/${token}.json`;
		await c.env.BUCKET.put(
			tokenKey,
			JSON.stringify({
				userId: user.id,
				email: user.email,
				expiresAt,
			}),
			{
				customMetadata: {
					expiresAt: expiresAt.toString(),
				},
			},
		);

		// Send recovery email
		const resetLink = `${new URL(c.req.url).origin}/reset-password?token=${token}`;

		const message = buildPasswordResetEmail(locale, resetLink);

		try {
			// The reset belongs to the person being reset, so it goes through
			// their key. Somebody with no key cannot be sent one -- which is a
			// service that has stopped, not a lockout: root sets a password
			// directly, with no mail involved at all.
			await sendEmail(
				c.env,
				{
					from: fromEmail,
					to: email,
					subject: message.subject,
					html: message.html,
					text: message.text,
				},
				await authStub.getPersonId(user.id),
			);
		} catch (e) {
			// Also indistinguishable from the unknown-address case: a send only
			// ever fails for an address that does exist, so surfacing the
			// failure would re-open the enumeration this route just closed.
			// The operator still sees it in the Worker's logs.
			console.error("Failed to send recovery email:", e);
		}

		return c.json({ status: "Password reset email sent" });
	}
}

class PostResetPassword extends OpenAPIRoute {
	schema = {
		summary: "Reset password with token",
		operationId: "resetPassword",
		tags: ["Auth"],
		request: {
			body: contentJson(ResetPasswordRequestSchema),
		},
		responses: {
			"200": {
				description: "Password reset successfully",
				...contentJson(SuccessResponseSchema),
			},
			"400": {
				description: "Bad request",
				...contentJson(ErrorResponseSchema),
			},
			"401": {
				description: "Invalid or expired token",
				...contentJson(ErrorResponseSchema),
			},
			"503": {
				description: "Account recovery disabled",
				...contentJson(ErrorResponseSchema),
			},
		},
	};

	async handle(c: AppContext) {
		const fromEmail = recoveryFromEmail(c.env);
		if (!fromEmail) {
			return c.json({ error: "Account recovery is not enabled" }, 503);
		}

		const data = await this.getValidatedData<typeof this.schema>();
		const { token, newPassword } = data.body;

		// Verify token
		const tokenKey = `recovery-tokens/${token}.json`;
		const tokenObj = await c.env.BUCKET.get(tokenKey);

		if (!tokenObj) {
			return c.json({ error: "Invalid or expired token" }, 401);
		}

		const tokenData = await tokenObj.json<{
			userId: string;
			email: string;
			expiresAt: number;
		}>();

		if (tokenData.expiresAt < Date.now()) {
			await c.env.BUCKET.delete(tokenKey);
			return c.json({ error: "Token has expired" }, 401);
		}

		// Update password
		const ns = c.env.MAILBOX;
		const authId = ns.idFromName("AUTH");
		const authStub = ns.get(authId);

		try {
			await authStub.updateUserPassword(tokenData.userId, newPassword);
		} catch (e) {
			return c.json({ error: "Failed to update password" }, 500);
		}

		// Delete used token
		await c.env.BUCKET.delete(tokenKey);

		return c.json({ status: "Password reset successfully" });
	}
}

/**
 * The Resend API key, for administrators.
 *
 * The key is never returned -- only whether one is set and where it came
 * from. That is all the screen needs in order to be useful, and it means a
 * stolen session cannot be turned into a stolen key.
 *
 * Deliberately not part of GET /api/v1/settings: that route is public (see
 * PUBLIC_ROUTES), and whether outbound mail is configured is not something to
 * tell someone who cannot sign in.
 */
class GetResendSettings extends OpenAPIRoute {
	schema = {
		summary: "Whether an outbound mail API key is configured (admin only)",
		operationId: "getResendSettings",
		tags: ["Admin"],
		responses: {
			"200": {
				description: "Key status, never the key",
				...contentJson(
					z.object({ source: z.enum(["stored", "environment", "none"]) }),
				),
			},
			"401": {
				description: "Unauthorized",
				...contentJson(ErrorResponseSchema),
			},
			"403": {
				description: "Forbidden - Admin privileges required",
				...contentJson(ErrorResponseSchema),
			},
		},
	};

	async handle(c: AppContext) {
		const session = c.get("session");
		if (!session) {
			return c.json({ error: "Unauthorized" }, 401);
		}
		// Your own key. Every signed-in person has one to look at, root
		// included -- root's sends root's own mail and stands behind nobody
		// else's, which is what keeps the deployment out of its customers'
		// sending costs.
		return c.json({
			source: await getResendKeySource(c.env, session.personId),
		});
	}
}

class PutResendSettings extends OpenAPIRoute {
	schema = {
		summary: "Set or clear the outbound mail API key (admin only)",
		operationId: "putResendSettings",
		tags: ["Admin"],
		request: {
			body: contentJson(z.object({ apiKey: z.string() })),
		},
		responses: {
			"200": {
				description: "Stored",
				...contentJson(
					z.object({ source: z.enum(["stored", "environment", "none"]) }),
				),
			},
			"401": {
				description: "Unauthorized",
				...contentJson(ErrorResponseSchema),
			},
			"403": {
				description: "Forbidden - Admin privileges required",
				...contentJson(ErrorResponseSchema),
			},
		},
	};

	async handle(c: AppContext) {
		const session = c.get("session");
		if (!session) {
			return c.json({ error: "Unauthorized" }, 401);
		}
		if (!session.personId) {
			return c.json({ error: "Account has no person" }, 409);
		}

		const data = await this.getValidatedData<typeof this.schema>();
		// An empty string clears the stored key rather than storing an empty
		// one, which would send `Bearer ` and fail every message.
		await setResendApiKey(c.env, session.personId, data.body.apiKey || null);
		return c.json({
			source: await getResendKeySource(c.env, session.personId),
		});
	}
}

class GetAppSettings extends OpenAPIRoute {
	schema = {
		summary: "Get application settings",
		operationId: "getAppSettings",
		tags: ["Settings"],
		responses: {
			"200": {
				description: "Application settings",
				...contentJson(AppSettingsResponseSchema),
			},
		},
	};

	async handle(c: AppContext) {
		const config = c.env.config || {};
		const authEnabled = config.auth?.enabled !== false;

		// Check if there are any users in the system
		let userCount = 0;
		if (authEnabled) {
			const ns = c.env.MAILBOX;
			const authId = ns.idFromName("AUTH");
			const authStub = ns.get(authId);
			try {
				const users = await authStub.getUsers();
				userCount = users.length;
			} catch (e) {
				// If we can't get users, assume there are users (safer default)
				userCount = 1;
			}
		}

		// Registration is enabled if:
		// 1. Explicitly enabled in config, OR
		// 2. Not explicitly disabled AND there are 0 users (fresh app)
		const registerEnabled =
			config.auth?.registerEnabled === true ||
			(config.auth?.registerEnabled !== false && userCount === 0);

		// Account recovery is on exactly when a from-address is configured,
		// from either source. See recoveryFromEmail.
		const accountRecoveryEnabled = recoveryFromEmail(c.env) !== undefined;

		return c.json({
			auth: {
				enabled: authEnabled,
				registerEnabled,
			},
			accountRecovery: {
				enabled: accountRecoveryEnabled,
			},
		});
	}
}

// Helper function to extract session token
function getSessionToken(request: Request): string | null {
	// Try Authorization header first
	const authHeader = request.headers.get("Authorization");
	if (authHeader?.startsWith("Bearer ")) {
		return authHeader.substring(7);
	}

	// Try cookie
	const cookie = request.headers.get("Cookie");
	if (cookie) {
		const match = cookie.match(/session=([^;]+)/);
		return match ? match[1] : null;
	}

	return null;
}

// Helper function to validate session
async function validateSession(
	request: Request,
	env: Env,
): Promise<Session | null> {
	const token = getSessionToken(request);
	if (!token) return null;

	const authId = env.MAILBOX.idFromName("AUTH");
	const authDO = env.MAILBOX.get(authId);

	try {
		const session = await authDO.validateSession(token);
		if (!session) return null;
		// The one place every authenticated request passes through. Deciding
		// the role anywhere else would mean a route that forgot to ask.
		const [personId, rootPersonId] = await Promise.all([
			authDO.getPersonId(session.userId),
			authDO.getRootPersonId(),
		]);
		return {
			...session,
			personId: personId ?? undefined,
			role: roleOf(personId, rootPersonId),
		};
	} catch {
		return null;
	}
}

/**
 * The endpoints that may be reached without a session.
 *
 * Matched exactly, never by prefix: a prefix match makes every future path
 * that happens to start with one of these strings public too, which is the
 * kind of hole nobody notices until it is being used. The API docs are not
 * here on purpose -- they enumerate every route and its schema, and there is
 * no reason for that to be readable by someone who cannot log in.
 */
const PUBLIC_ROUTES = new Set([
	"/api/v1/auth/register",
	"/api/v1/auth/login",
	"/api/v1/auth/forgot-password",
	"/api/v1/auth/reset-password",
	// Reached from a link in the confirmation mail, possibly on a device that
	// has never signed in. The token is the credential, and issuing one
	// already required the session and the current password.
	"/api/v1/auth/confirm-email-change",
	"/api/v1/settings",
]);

// Helper function to check if route is public
function isPublicRoute(pathname: string): boolean {
	return PUBLIC_ROUTES.has(pathname);
}

// Helper function to check if route requires session (auth routes)
function requiresSession(pathname: string): boolean {
	const authRoutes = [
		"/api/v1/auth/me",
		"/api/v1/auth/logout",
		"/api/v1/auth/admin",
	];
	return authRoutes.some((route) => pathname.startsWith(route));
}

const app = new Hono<{ Bindings: Env; Variables: { session?: Session } }>();
app.use("/api/*", cors());
const openapi = fromHono(app);

// Auth endpoints
openapi.post("/api/v1/auth/register", PostRegister);
openapi.post("/api/v1/auth/login", PostLogin);
openapi.post("/api/v1/auth/logout", PostLogout);
openapi.get("/api/v1/auth/me", GetMe);
openapi.post("/api/v1/auth/forgot-password", PostForgotPassword);
openapi.post("/api/v1/auth/reset-password", PostResetPassword);
openapi.post("/api/v1/auth/change-password", PostChangePassword);
openapi.post("/api/v1/auth/change-email", PostChangeEmail);
openapi.post("/api/v1/auth/confirm-email-change", PostConfirmEmailChange);
openapi.post("/api/v1/auth/admin/register", PostAdminRegister);
openapi.get("/api/v1/auth/admin/users", GetUsers);
openapi.delete("/api/v1/auth/admin/users/:userId", DeleteOwnLogin);

// Root: the account list, and nothing that returns mail. See routes/root.ts.
openapi.get("/api/v1/root/accounts", GetAccounts);
openapi.post("/api/v1/root/accounts", PostAccount);
openapi.post("/api/v1/root/accounts/:userId/password", PostAccountPassword);
openapi.delete("/api/v1/root/accounts/:personId", DeleteAccount);
openapi.post("/api/v1/admin/mailboxes/:mailboxId/import", PostImportEmail);

// Push notification endpoints
openapi.get("/api/v1/push/vapid-public-key", GetVapidPublicKey);
openapi.post("/api/v1/push/subscribe", PostPushSubscribe);
openapi.post("/api/v1/push/unsubscribe", PostPushUnsubscribe);

// Settings endpoints
openapi.get("/api/v1/settings", GetAppSettings);
openapi.get("/api/v1/admin/settings/resend", GetResendSettings);
openapi.put("/api/v1/admin/settings/resend", PutResendSettings);

// Existing endpoints
openapi.get("/api/v1/mailboxes", GetMailboxes);
openapi.post("/api/v1/mailboxes", PostMailbox);
openapi.get("/api/v1/mailboxes/:mailboxId", GetMailbox);
openapi.put("/api/v1/mailboxes/:mailboxId", PutMailbox);
openapi.delete("/api/v1/mailboxes/:mailboxId", DeleteMailbox);
openapi.get("/api/v1/mailboxes/:mailboxId/export", GetMailboxExport);
// Listing and downloading only. There is deliberately no delete route:
// rotation in the scheduled run is the only thing that removes a backup.
openapi.post(
	"/api/v1/mailboxes/:mailboxId/spam-filter/check",
	PostSpamFilterCheck,
);
openapi.get("/api/v1/mailboxes/:mailboxId/backups", GetMailboxBackups);
openapi.get("/api/v1/mailboxes/:mailboxId/backups/:name", GetMailboxBackup);
openapi.get("/api/v1/mailboxes/:mailboxId/emails", GetEmails);
openapi.post("/api/v1/mailboxes/:mailboxId/emails", PostEmail);
openapi.get("/api/v1/mailboxes/:mailboxId/emails/:id", GetEmail);
openapi.put("/api/v1/mailboxes/:mailboxId/emails/:id", PutEmail);
openapi.delete("/api/v1/mailboxes/:mailboxId/emails/:id", DeleteEmail);
openapi.post("/api/v1/mailboxes/:mailboxId/emails/:id/move", PostMoveEmail);
openapi.post(
	"/api/v1/mailboxes/:mailboxId/emails/:id/spam-verdict",
	PostEmailSpamVerdict,
);
openapi.post("/api/v1/mailboxes/:mailboxId/emails/:id/reply", PostReplyEmail);
openapi.post(
	"/api/v1/mailboxes/:mailboxId/emails/:id/forward",
	PostForwardEmail,
);
openapi.post("/api/v1/mailboxes/:mailboxId/drafts", PostDraftEmail);
openapi.put("/api/v1/mailboxes/:mailboxId/drafts/:id", PutDraftEmail);
openapi.get("/api/v1/mailboxes/:mailboxId/folders", GetFolders);
openapi.post("/api/v1/mailboxes/:mailboxId/folders", PostFolder);
openapi.put("/api/v1/mailboxes/:mailboxId/folders/:id", PutFolder);
openapi.delete("/api/v1/mailboxes/:mailboxId/folders/:id", DeleteFolder);
openapi.get("/api/v1/mailboxes/:mailboxId/contacts", GetContacts);
openapi.post("/api/v1/mailboxes/:mailboxId/contacts", PostContact);
openapi.put("/api/v1/mailboxes/:mailboxId/contacts/:id", PutContact);
openapi.delete("/api/v1/mailboxes/:mailboxId/contacts/:id", DeleteContact);
openapi.get("/api/v1/mailboxes/:mailboxId/search", GetSearch);
openapi.get(
	"/api/v1/mailboxes/:mailboxId/emails/:emailId/attachments/:attachmentId",
	GetAttachment,
);
openapi.get(
	"/api/v1/mailboxes/:mailboxId/emails/:emailId/source",
	GetEmailSource,
);
openapi.put(
	"/api/v1/mailboxes/:mailboxId/emails/:emailId/source",
	PutEmailSource,
);

async function streamToArrayBuffer(stream: ReadableStream, streamSize: number) {
	const result = new Uint8Array(streamSize);
	let bytesRead = 0;
	const reader = stream.getReader();
	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		result.set(value, bytesRead);
		bytesRead += value.length;
	}
	return result;
}

async function receiveEmail(
	event: {
		raw: ReadableStream;
		rawSize: number;
		to?: string;
		setReject?: (reason: string) => void;
	},
	env: Env,
	_ctx: ExecutionContext,
) {
	// Which mailbox this belongs to is decided by the envelope recipient --
	// the address Cloudflare Email Routing actually delivered to -- and never
	// by the "To:" header. The header is written by the sender and routinely
	// names somebody else (Bcc, mailing lists, forwarded mail), so trusting it
	// filed our mail under addresses that were never ours.
	const mailboxId = event.to?.trim().toLowerCase();
	if (!mailboxId) {
		throw new Error("received email with no envelope recipient");
	}

	// Deliver only into a mailbox that already exists. Creating one on arrival
	// meant any address could become a mailbox nobody watches: no push
	// notification, no unread badge, and the message effectively lost.
	const mailboxExists = await env.BUCKET.head(`mailboxes/${mailboxId}.json`);
	if (!mailboxExists) {
		const reason = `No mailbox exists for ${mailboxId}`;
		console.error(`Rejected incoming email: ${reason}`);
		event.setReject?.(reason);
		return;
	}

	const rawEmail = await streamToArrayBuffer(event.raw, event.rawSize);
	const parser = new PostalMime();
	const parsedEmail = await parser.parse(rawEmail);

	// Highest precedence: the user has explicitly marked this exact sender
	// as spam or not-spam before (see PostEmailSpamVerdict). That's a
	// stronger signal than any automated check, so it short-circuits
	// everything below -- no auth check, no Claude call.
	const senderOverride = await getSenderVerdictOverride(
		env,
		mailboxId,
		parsedEmail.from?.address,
	);

	let folder: "inbox" | "spam" =
		senderOverride ?? classifyByAuthResults(parsedEmail.headers);

	// Second-stage check: only for mail that already passed SPF/DKIM/DMARC
	// (mail that failed it is spam regardless), and only when the mailbox
	// owner has opted in by configuring a Claude API key. No key -> skip
	// entirely, no API call made. Also skipped for DMARC-aligned mail sent
	// from the mailbox's own domain (e.g. the business's own transactional
	// systems) -- see isTrustedSelfDomainSender for why this is narrow and
	// doesn't weaken detection of confirmation-link-style phishing from
	// other domains.
	if (
		!senderOverride &&
		folder === "inbox" &&
		!isTrustedSelfDomainSender(
			parsedEmail.headers,
			parsedEmail.from?.address,
			mailboxId,
		)
	) {
		const claudeApiKey = await getClaudeApiKey(env, mailboxId);
		if (claudeApiKey) {
			const checked = await classifyWithClaude({
				apiKey: claudeApiKey,
				subject: parsedEmail.subject || "",
				from: parsedEmail.from?.address || "",
				// The display name and the authentication verdicts both used to
				// be dropped here. Impersonation lives in the gap between the
				// two halves of the From line -- a household brand name over an
				// address on an unrelated domain -- and passing only the address
				// hid exactly that. The verdicts matter for the opposite reason:
				// this stage is reached only by mail that already passed them,
				// so without them the classifier cannot tell mail that passed
				// cleanly from mail that passed with a broken signature on a
				// domain that enforces nothing.
				fromName: parsedEmail.from?.name,
				auth: summarizeAuthResults(parsedEmail.headers),
				text: parsedEmail.text,
				html: parsedEmail.html,
			});
			folder = checked.folder;

			// The check fails open, so a rejected key looks exactly like a
			// filter finding nothing to catch. Recorded here rather than logged
			// and forgotten, so the settings screen can say so.
			const ns = env.MAILBOX;
			await ns
				.get(ns.idFromName(mailboxId))
				.recordSpamCheck(
					new Date().toISOString(),
					checked.failure,
					checked.detail,
				);
		}
	}

	await ingestEmailIntoMailbox(env, mailboxId, folder, parsedEmail, {
		notify: true,
		rawEmail,
	});
}

const defaultOptions: EmailExplorerOptions = {
	auth: {
		enabled: true, // Auth is enabled by default for security
		registerEnabled: undefined, // Smart mode: first user becomes admin, then registration closes
	},
};

export function EmailExplorer(_options: EmailExplorerOptions = {}) {
	// Merge user options with defaults
	const options: EmailExplorerOptions = {
		..._options,
		auth: {
			...defaultOptions.auth,
			..._options.auth,
		},
	};

	return {
		async email(
			event: {
				raw: ReadableStream;
				rawSize: number;
				to?: string;
				setReject?: (reason: string) => void;
			},
			env: Env,
			context: ExecutionContext,
		) {
			await receiveEmail(event, env, context);
		},
		/**
		 * The cron fires once a day for the whole Worker; each mailbox's own
		 * settings decide what happens to it (see backup-run and
		 * spam-purge-run).
		 *
		 * Awaited rather than handed to waitUntil: a scheduled invocation is
		 * allowed to take its time, and returning early would let the run be
		 * cut off partway through a mailbox.
		 */
		async scheduled(
			_event: { cron: string; scheduledTime: number },
			env: Env,
			_context: ExecutionContext,
		) {
			env.config = options;
			await ensureLegacyMailboxGrants(env);
			await runScheduledMaintenance(env);
		},
		async fetch(request: Request, env: Env, context: ExecutionContext) {
			// Make options available to routes via env
			env.config = options;

			// Create a new request with context for middleware
			const url = new URL(request.url);

			// Check if auth is required (either globally enabled or auth-specific routes)
			// Auth is enforced by default (when enabled is undefined) unless explicitly disabled
			const needsAuth =
				(options.auth?.enabled !== false && !isPublicRoute(url.pathname)) ||
				requiresSession(url.pathname);

			if (needsAuth) {
				const session = await validateSession(request, env);
				if (!session) {
					return new Response(JSON.stringify({ error: "Unauthorized" }), {
						status: 401,
						headers: { "Content-Type": "application/json" },
					});
				}

				// Create new Hono app with session in context
				const authApp = new Hono<{
					Bindings: Env;
					Variables: { session?: Session };
				}>();

				// Middleware to inject session
				authApp.use("*", async (c, next) => {
					c.set("session", session);
					await next();
				});

				// Middleware to check mailbox access. The admin flag used to
				// skip this entirely; now the question is whether the mailbox
				// belongs to this person, through any of their logins.
				const checkMailboxAccess = async (c: any, next: any) => {
					const mailboxId = c.req.param("mailboxId");
					if (!mailboxId) {
						await next();
						return;
					}
					const authId = env.MAILBOX.idFromName("AUTH");
					const authDO = env.MAILBOX.get(authId);
					const held = await authDO.getPersonMailboxes(session.userId);
					if (!held.includes(mailboxId)) {
						return c.json(
							{ error: "You don't have access to this mailbox" },
							403,
						);
					}
					await next();
				};
				authApp.use("/api/v1/mailboxes/:mailboxId", checkMailboxAccess);
				authApp.use("/api/v1/mailboxes/:mailboxId/*", checkMailboxAccess);

				// Mount the main app
				authApp.route("/", app);

				return authApp.fetch(request, env, context);
			}

			return app.fetch(request, env, context);
		},
	};
}
