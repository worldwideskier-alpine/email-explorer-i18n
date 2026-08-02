import { contentJson, OpenAPIRoute } from "chanfana";
import type { Context } from "hono";
import PostalMime from "postal-mime";
import { z } from "zod";
import { ingestEmailIntoMailbox } from "../email-ingest";
import type { Env, Session } from "../types";

type AppContext = Context<{ Bindings: Env; Variables: { session?: Session } }>;

const ImportEmailRequestSchema = z.object({
	folder: z.string().default("inbox"),
	rawEmailBase64: z.string(),
	date: z.string().optional(),
	read: z.boolean().optional(),
	starred: z.boolean().optional(),
});

const ImportEmailResponseSchema = z.object({
	id: z.string(),
	status: z.string(),
});

const ErrorResponseSchema = z.object({
	error: z.string(),
});

/**
 * Admin-only endpoint used by the IMAP migration script (tools/imap-migration)
 * to insert a historical message into a mailbox without sending it. Reuses
 * the same postal-mime parsing and ingestion path as real inbound mail
 * (see email-ingest.ts), so imported messages behave identically to mail
 * that arrived via Cloudflare Email Routing.
 */
export class PostImportEmail extends OpenAPIRoute {
	schema = {
		summary: "Import a raw email into a mailbox (admin only, does not send)",
		operationId: "importEmail",
		tags: ["Admin"],
		request: {
			params: z.object({
				mailboxId: z.string(),
			}),
			body: contentJson(ImportEmailRequestSchema),
		},
		responses: {
			"201": {
				description: "Email imported successfully",
				...contentJson(ImportEmailResponseSchema),
			},
			"401": {
				description: "Unauthorized",
				...contentJson(ErrorResponseSchema),
			},
			"403": {
				description: "Forbidden - Admin privileges required",
				...contentJson(ErrorResponseSchema),
			},
			"400": {
				description: "Bad request",
				...contentJson(ErrorResponseSchema),
			},
		},
	};

	async handle(c: AppContext) {
		const session = c.get("session");
		if (!session) {
			return c.json({ error: "Unauthorized" }, 401);
		}
		if (!session.isAdmin) {
			return c.json({ error: "Admin privileges required" }, 403);
		}

		const data = await this.getValidatedData<typeof this.schema>();
		const { mailboxId } = data.params;
		const { folder, rawEmailBase64, date, read, starred } = data.body;

		let rawEmail: Uint8Array;
		try {
			rawEmail = Uint8Array.from(atob(rawEmailBase64), (ch) => ch.charCodeAt(0));
		} catch {
			return c.json({ error: "rawEmailBase64 is not valid base64" }, 400);
		}

		const parser = new PostalMime();
		const parsedEmail = await parser.parse(rawEmail);

		const id = await ingestEmailIntoMailbox(c.env, mailboxId, folder, parsedEmail, {
			date,
			read,
			starred,
		});

		return c.json({ id, status: "imported" }, 201);
	}
}
