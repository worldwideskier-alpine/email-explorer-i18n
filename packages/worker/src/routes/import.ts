import { contentJson, OpenAPIRoute } from "chanfana";
import type { Context } from "hono";
import PostalMime from "postal-mime";
import { z } from "zod";
import { ingestEmailIntoMailbox } from "../email-ingest";
import { personHoldsMailbox } from "../mailbox-access";
import { slugify } from "../slugify";
import type { Env, Session } from "../types";

type AppContext = Context<{ Bindings: Env; Variables: { session?: Session } }>;

const ImportEmailRequestSchema = z.object({
	/**
	 * A folder id ("inbox") or its display name ("Inbox", or a folder the user
	 * made). A backup names folders rather than identifying them, because the
	 * id of a folder with a Japanese name is a random uuid that means nothing
	 * in the mailbox being restored into.
	 */
	folder: z.string().default("inbox"),
	rawEmailBase64: z.string(),
	date: z.string().optional(),
	read: z.boolean().optional(),
	starred: z.boolean().optional(),
	/**
	 * The id this message had when it was exported. Restoring the same file
	 * twice should not double the mailbox, so an id already present here is
	 * reported back as a duplicate and nothing is written.
	 */
	id: z.string().optional(),
});

const ImportEmailResponseSchema = z.object({
	id: z.string(),
	status: z.string(),
});

const ErrorResponseSchema = z.object({
	error: z.string(),
});

/**
 * Inserts a historical message into a mailbox without sending it -- the
 * receiving side of an IMAP import, and what "restore from backup" posts to,
 * one message at a time. Reuses the same postal-mime parsing and ingestion
 * path as real inbound mail (see email-ingest.ts), so imported messages
 * behave identically to mail that arrived via Cloudflare Email Routing.
 *
 * Open to whoever holds the mailbox, which is the rule everywhere else here.
 * See the check in handle() for what it used to be and what that cost.
 */
export class PostImportEmail extends OpenAPIRoute {
	schema = {
		summary: "Import a raw email into a mailbox (does not send)",
		operationId: "importEmail",
		tags: ["Admin"],
		request: {
			params: z.object({
				mailboxId: z.string(),
			}),
			body: contentJson(ImportEmailRequestSchema),
		},
		responses: {
			"200": {
				description: "That id is already in this mailbox; nothing written",
				...contentJson(ImportEmailResponseSchema),
			},
			"201": {
				description: "Email imported successfully",
				...contentJson(ImportEmailResponseSchema),
			},
			"401": {
				description: "Unauthorized",
				...contentJson(ErrorResponseSchema),
			},
			"403": {
				description: "Forbidden - this mailbox is not yours",
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
		/**
		 * Whether this mailbox is yours -- the same question every other
		 * mailbox-scoped route asks, and the one this route was not asking.
		 *
		 * Asked before the body is read, from the path rather than from the
		 * validated data. Validating first means parsing a stranger's body on
		 * their behalf and answering 400 where the answer is 403 -- telling
		 * somebody with no rights here whether their payload was well formed.
		 *
		 * It used to ask for `session.isAdmin`, which is the legacy `is_admin`
		 * column, and that column is set for exactly one account: the first
		 * one ever registered. Every administrator made since -- there is no
		 * other way to make one -- got 403 from here, so restoring a backup
		 * was a thing one particular account could do and no other could,
		 * which is not what "administrator" means anywhere else in this
		 * deployment. The screen hid the control from them too, so it looked
		 * like a missing feature rather than a refusal.
		 *
		 * Ownership is also the narrower question of the two. The flag said
		 * yes for every mailbox there was, so the one account that had it
		 * could write mail into somebody else's; holding the mailbox is the
		 * rule the rest of the application already follows.
		 */
		const mailboxId = c.req.param("mailboxId");
		if (!mailboxId) {
			return c.json({ error: "Not found" }, 404);
		}
		if (!(await personHoldsMailbox(c.env, session, mailboxId))) {
			return c.json({ error: "You don't have access to this mailbox" }, 403);
		}

		const data = await this.getValidatedData<typeof this.schema>();
		const {
			folder,
			rawEmailBase64,
			date,
			read,
			starred,
			id: requestedId,
		} = data.body;

		let rawEmail: Uint8Array;
		try {
			rawEmail = Uint8Array.from(atob(rawEmailBase64), (ch) =>
				ch.charCodeAt(0),
			);
		} catch {
			return c.json({ error: "rawEmailBase64 is not valid base64" }, 400);
		}

		const ns = c.env.MAILBOX;
		const stub = ns.get(ns.idFromName(mailboxId));

		// Already here, so the caller is replaying a backup this mailbox has
		// already taken back. Saying so beats writing a second copy.
		if (requestedId && (await stub.getEmail(requestedId))) {
			return c.json({ id: requestedId, status: "duplicate" }, 200);
		}

		// The id is only reused when nothing else owns it. R2 keys are not
		// scoped per mailbox, so restoring one mailbox's backup into a
		// different mailbox would otherwise overwrite the raw copy the
		// original still points at.
		const idIsFree =
			requestedId !== undefined &&
			!(await c.env.BUCKET.head(`raw/${requestedId}.eml`));

		const parser = new PostalMime();
		const parsedEmail = await parser.parse(rawEmail);

		const id = await ingestEmailIntoMailbox(
			c.env,
			mailboxId,
			await resolveFolder(stub, folder),
			parsedEmail,
			{
				date,
				read,
				starred,
				rawEmail,
				id: idIsFree ? requestedId : undefined,
			},
		);

		return c.json({ id, status: "imported" }, 201);
	}
}

/**
 * Turns whatever the caller called the folder into an id the emails row can
 * hold, creating the folder when the mailbox does not have it. A restore into
 * an empty mailbox has to rebuild the folders as well as the mail, and the
 * alternative -- dropping those messages into the inbox -- loses exactly what
 * the backup went to the trouble of recording.
 */
async function resolveFolder(
	stub: {
		getFolders: () => Promise<unknown[]>;
		createFolder: (id: string, name: string) => Promise<unknown>;
	},
	folder: string,
): Promise<string> {
	const folders = (await stub.getFolders()) as { id: string; name: string }[];
	const existing = folders.find(
		(row) => row.id === folder || row.name === folder,
	);
	if (existing) return existing.id;

	const id = slugify(folder);
	await stub.createFolder(id, folder);

	// createFolder answers null when the name is taken, which here means it
	// was created between the read above and this write; either way the
	// folder now exists, so read back rather than trusting the return.
	const after = (await stub.getFolders()) as { id: string; name: string }[];
	return (
		after.find((row) => row.id === folder || row.name === folder)?.id ?? id
	);
}
