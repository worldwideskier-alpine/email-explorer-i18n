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
	 * twice should not double the mailbox, so a message already restored
	 * from it -- or still here under it -- is reported back as a duplicate
	 * and nothing is written. The message is restored under an id made from
	 * this one and the mailbox, never this one itself; see handle().
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

/** The shape of an id this application mints (crypto.randomUUID). */
const MINTED_ID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The id a message recorded as `recordedId` is restored under in `mailboxId`:
 * a digest of the two, shaped like the ids this mints. See handle().
 */
async function restoredIdFor(
	mailboxId: string,
	recordedId: string,
): Promise<string> {
	const digest = new Uint8Array(
		await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(`${mailboxId}\n${recordedId.toLowerCase()}`),
		),
	);
	const hex = [...digest.slice(0, 16)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

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
		// Outside the /mailboxes/:mailboxId gate, so it asks the gate's other
		// question itself: a deleted mailbox is not restored into. Ingest used
		// to create an empty settings object for it, which brought the mailbox
		// back without the settings kept for its holder -- the backup count at
		// the minimum, free to be lowered.
		if (!(await c.env.BUCKET.head(`mailboxes/${mailboxId}.json`))) {
			return c.json({ error: "Mailbox not found" }, 404);
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

		// Already here under the id it was exported with: the original is
		// still in this mailbox, or a restore from before ids were made per
		// mailbox took it back. Saying so beats writing a second copy.
		if (requestedId && (await stub.getEmail(requestedId))) {
			return c.json({ id: requestedId, status: "duplicate" }, 200);
		}

		// Never the recorded id itself, but one made from it and this
		// mailbox. R2 keys carry a message id and no mailbox, so a restored
		// message that kept its id shared every key under it with the
		// original -- and "nothing is stored under this id yet" could not
		// tell a sent message without attachments, which stores nothing,
		// from an id nobody uses. Restoring one mailbox's backup into another
		// then wrote `raw/{id}.eml` for an id the first mailbox's row still
		// named, and deleting, reading or purging there reached the copy
		// here. An id made from the pair is this mailbox's alone, and the
		// same every time, so feeding the same file in twice still finds
		// what the first pass wrote. It also has to be an id of the kind this
		// mints: one with a "/" in it would have named keys in somebody
		// else's space.
		const restoredId =
			requestedId !== undefined && MINTED_ID.test(requestedId)
				? await restoredIdFor(mailboxId, requestedId)
				: undefined;
		if (restoredId && (await stub.getEmail(restoredId))) {
			return c.json({ id: restoredId, status: "duplicate" }, 200);
		}

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
				id: restoredId,
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
