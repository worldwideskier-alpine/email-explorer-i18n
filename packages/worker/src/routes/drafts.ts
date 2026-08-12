import { contentJson, OpenAPIRoute } from "chanfana";
import type { Context } from "hono";
import { z } from "zod";
import type { Env, Session } from "../types";

type AppContext = Context<{ Bindings: Env; Variables: { session?: Session } }>;

const DraftEmailRequestSchema = z.object({
	to: z.string().optional().default(""),
	from: z.string().email(),
	subject: z.string().optional().default(""),
	html: z.string().optional().default(""),
});

const DraftEmailResponseSchema = z.object({
	id: z.string(),
	status: z.string(),
});

const ErrorResponseSchema = z.object({
	error: z.string(),
});

export class PostDraftEmail extends OpenAPIRoute {
	schema = {
		summary: "Save a new draft email",
		operationId: "saveDraftEmail",
		tags: ["Emails"],
		request: {
			params: z.object({
				mailboxId: z.string(),
			}),
			body: contentJson(DraftEmailRequestSchema),
		},
		responses: {
			"201": {
				description: "Draft saved successfully",
				...contentJson(DraftEmailResponseSchema),
			},
			"404": { description: "Not found", ...contentJson(ErrorResponseSchema) },
		},
	};

	async handle(c: AppContext) {
		const data = await this.getValidatedData<typeof this.schema>();
		const { mailboxId } = data.params;
		const { to, from, subject, html } = data.body;

		const key = `mailboxes/${mailboxId}.json`;
		const obj = await c.env.BUCKET.head(key);
		if (!obj) {
			return c.json({ error: "Not found" }, 404);
		}

		const ns = c.env.MAILBOX;
		const doId = ns.idFromName(mailboxId);
		const stub = ns.get(doId);

		const draftId = crypto.randomUUID();

		await stub.createEmail(
			"draft",
			{
				id: draftId,
				subject,
				sender: from,
				recipient: to,
				date: new Date().toISOString(),
				body: html,
			},
			[],
		);

		return c.json({ id: draftId, status: "saved" }, 201);
	}
}

export class PutDraftEmail extends OpenAPIRoute {
	schema = {
		summary: "Update an existing draft email",
		operationId: "updateDraftEmail",
		tags: ["Emails"],
		request: {
			params: z.object({
				mailboxId: z.string(),
				id: z.string(),
			}),
			body: contentJson(DraftEmailRequestSchema),
		},
		responses: {
			"200": {
				description: "Draft updated successfully",
				...contentJson(DraftEmailResponseSchema),
			},
			"404": { description: "Not found", ...contentJson(ErrorResponseSchema) },
		},
	};

	async handle(c: AppContext) {
		const data = await this.getValidatedData<typeof this.schema>();
		const { mailboxId, id } = data.params;
		const { to, from, subject, html } = data.body;

		const key = `mailboxes/${mailboxId}.json`;
		const obj = await c.env.BUCKET.head(key);
		if (!obj) {
			return c.json({ error: "Not found" }, 404);
		}

		const ns = c.env.MAILBOX;
		const doId = ns.idFromName(mailboxId);
		const stub = ns.get(doId);

		const existing = (await stub.getEmail(id)) as any;
		if (!existing || existing.folder_id !== "draft") {
			return c.json({ error: "Draft not found" }, 404);
		}

		await stub.updateDraftContent(id, {
			subject,
			sender: from,
			recipient: to,
			body: html,
		});

		return c.json({ id, status: "saved" }, 200);
	}
}
