/**
 * What the root account can do, and nothing else can.
 *
 * Root's whole job is the account list: create an account, reset its
 * password, delete it, and say which mailboxes belong to it. It owns no
 * mailbox and reads no mail -- there is no route here that returns a message,
 * a subject or a sender, and that is deliberate rather than an omission. The
 * person who can create and delete every account should not also be a second
 * pair of eyes on every conversation.
 *
 * Who root is comes from the deployment's configuration, not from a column
 * anyone here can write; see roles.ts. Every route in this file therefore
 * refuses everyone on a deployment that has not named one, which is the state
 * a deployment upgrading into this starts in.
 */

import { contentJson, OpenAPIRoute } from "chanfana";
import type { Context } from "hono";
import { z } from "zod";
import { personSettingsKey } from "../app-settings";
import { destroyMailboxCompletely } from "../mailbox-destroy";
import { roleOf } from "../roles";
import type { Env, Session } from "../types";

type AppContext = Context<{ Bindings: Env; Variables: { session?: Session } }>;

const ErrorResponseSchema = z.object({ error: z.string() });
const SuccessResponseSchema = z.object({ status: z.string() });

/**
 * A person as root sees them.
 *
 * One entry per person, not per login. A person is the addresses they sign in
 * with and nothing else -- there is no name field, no attribute of any kind
 * -- so the list of those addresses is the whole of what can be shown, and
 * showing them as separate rows said two strangers where there was one
 * person, with a delete button on each.
 *
 * Which mailboxes they hold is deliberately absent. Root makes and unmakes
 * people; what somebody does with their own addresses afterwards is not
 * root's business, and listing them here would make it so.
 */
const PersonSchema = z.object({
	personId: z.string(),
	emails: z.array(z.string()),
	role: z.enum(["root", "admin"]),
	createdAt: z.number(),
});

const forbidden = {
	"401": { description: "Unauthorized", ...contentJson(ErrorResponseSchema) },
	"403": { description: "Root only", ...contentJson(ErrorResponseSchema) },
};

/**
 * The gate. Returns the session when the caller is root, or the response to
 * send back when it is not.
 *
 * The screen the dashboard shows is decided by the same role, but that is
 * convenience: a URL typed by hand skips it entirely. This is the boundary.
 */
function requireRoot(c: AppContext): Session | Response {
	const session = c.get("session");
	if (!session) return c.json({ error: "Unauthorized" }, 401);
	if (session.role !== "root") {
		return c.json({ error: "Root privileges required" }, 403);
	}
	return session;
}

function authDO(env: Env) {
	return env.MAILBOX.get(env.MAILBOX.idFromName("AUTH"));
}

export class GetAccounts extends OpenAPIRoute {
	schema = {
		summary: "List the people using this deployment (root only)",
		operationId: "listPeople",
		tags: ["Root"],
		responses: {
			"200": { description: "People", ...contentJson(z.array(PersonSchema)) },
			...forbidden,
		},
	};

	async handle(c: AppContext) {
		const session = requireRoot(c);
		if (session instanceof Response) return session;

		const rootPersonId = await authDO(c.env).getRootPersonId();
		const people = await authDO(c.env).listPeople();

		return c.json(
			people.map((person) => ({
				...person,
				role: roleOf(person.personId, rootPersonId),
			})),
		);
	}
}

/**
 * Two different acts behind one form.
 *
 * With `role: "admin"` this creates somebody new: a person who was not here
 * before, with one address to sign in with, who will register their own mail
 * addresses and see nothing of anybody else's.
 *
 * With `role: "root"` it adds another address **to root's own person**. That
 * is a spare, not a second root: the role belongs to the person, so a spare
 * carries it, and losing one address does not lose the deployment. It is the
 * same act an administrator performs on their own screen, and it is the whole
 * of root's succession -- there is deliberately no way to hand the role to
 * somebody else, because on software with customers that is a button that
 * gives a customer the deployment.
 *
 * Root cannot add a login to anybody else's person. An administrator's spare
 * addresses are their own business.
 */
export class PostAccount extends OpenAPIRoute {
	schema = {
		summary: "Create a person, or add a login to your own (root only)",
		operationId: "createPerson",
		tags: ["Root"],
		request: {
			body: contentJson(
				z.object({
					email: z.string().email(),
					password: z.string().min(8),
					role: z.enum(["root", "admin"]).default("admin"),
				}),
			),
		},
		responses: {
			"201": { description: "Created", ...contentJson(PersonSchema) },
			"400": {
				description: "Bad request",
				...contentJson(ErrorResponseSchema),
			},
			...forbidden,
		},
	};

	async handle(c: AppContext) {
		const session = requireRoot(c);
		if (session instanceof Response) return session;

		const { email, password, role } = (
			await this.getValidatedData<typeof this.schema>()
		).body;

		// "root" means this login joins the person already holding the role.
		// "admin" leaves the person unset, and register() makes a new one.
		const personId = role === "root" ? session.personId : undefined;
		if (role === "root" && !personId) {
			return c.json({ error: "No person to add this login to" }, 409);
		}

		try {
			const user = await authDO(c.env).register(
				email,
				password,
				false,
				personId,
			);
			const created = await authDO(c.env).getPersonId(user.id);
			return c.json(
				{
					personId: created ?? "",
					emails: [user.email],
					role,
					createdAt: user.createdAt,
				},
				201,
			);
		} catch (e) {
			if (String(e).includes("UNIQUE")) {
				return c.json({ error: "Email already registered" }, 400);
			}
			return c.json({ error: "Registration failed" }, 400);
		}
	}
}

export class PostAccountPassword extends OpenAPIRoute {
	schema = {
		summary: "Set a login's password (root only)",
		operationId: "setAccountPassword",
		tags: ["Root"],
		request: {
			params: z.object({ userId: z.string() }),
			body: contentJson(z.object({ password: z.string().min(8) })),
		},
		responses: {
			"200": { description: "Set", ...contentJson(SuccessResponseSchema) },
			"404": { description: "Not found", ...contentJson(ErrorResponseSchema) },
			...forbidden,
		},
	};

	async handle(c: AppContext) {
		const session = requireRoot(c);
		if (session instanceof Response) return session;

		const data = await this.getValidatedData<typeof this.schema>();
		const result = await authDO(c.env).setUserPassword(
			data.params.userId,
			data.body.password,
		);
		if (result === "not-found") return c.json({ error: "Not found" }, 404);
		return c.json({ status: "updated" });
	}
}

/**
 * Deletes a person and everything that was theirs.
 *
 * All of it: every login, every session, every mailbox they held, the
 * messages in those mailboxes, the raw copies, the attachments, and every
 * nightly archive. The deletion lock on a mailbox does not stop it -- that
 * lock protects an administrator from their own mis-click, and is not a
 * defence against the person running the deployment.
 *
 * This used to keep the mailboxes, on the reasoning that mail outlives
 * whoever read it. Between colleagues that is right. Here root is the person
 * running the deployment and the people below are its customers, and
 * "delete this customer" that leaves their mail in the bucket has deleted
 * nothing: it still costs, it is still readable from the Cloudflare account,
 * and no screen says it is there.
 *
 * Afterwards, mail addressed to those mailboxes is refused rather than
 * silently recreating them -- see the inbound handler, which delivers only
 * into a mailbox that already exists. Stopping stops.
 */
export class DeleteAccount extends OpenAPIRoute {
	schema = {
		summary: "Delete a person and all their mail (root only)",
		operationId: "deletePerson",
		tags: ["Root"],
		request: { params: z.object({ personId: z.string() }) },
		responses: {
			"200": { description: "Deleted", ...contentJson(SuccessResponseSchema) },
			"404": { description: "Not found", ...contentJson(ErrorResponseSchema) },
			"409": {
				description: "Root cannot be deleted",
				...contentJson(ErrorResponseSchema),
			},
			...forbidden,
		},
	};

	async handle(c: AppContext) {
		const session = requireRoot(c);
		if (session instanceof Response) return session;

		const { personId } = (await this.getValidatedData<typeof this.schema>())
			.params;

		// Root deleting itself would take the account list with it, and root
		// is not recreatable from inside the application.
		if (personId === session.personId) {
			return c.json({ error: "Cannot delete the root account" }, 409);
		}

		const result = await authDO(c.env).deletePerson(personId);
		if (result.status === "not-found") {
			return c.json({ error: "Not found" }, 404);
		}
		if (result.status === "is-root") {
			return c.json({ error: "Cannot delete the root account" }, 409);
		}

		// The account rows are gone whatever happens next, so nobody can reach
		// this mail through the application any more. The bucket is emptied
		// after that, and a failure part-way leaves objects that no longer
		// belong to anyone rather than an account that half exists.
		for (const mailboxId of result.mailboxIds) {
			await destroyMailboxCompletely(c.env, mailboxId);
		}
		// Their sending key goes too. It is theirs, it is a credential, and
		// leaving it behind after the account is gone leaves something nobody
		// owns that can still send mail.
		await c.env.BUCKET.delete(personSettingsKey(personId));

		return c.json({
			status: "deleted",
			mailboxes: result.mailboxIds.length,
		});
	}
}
