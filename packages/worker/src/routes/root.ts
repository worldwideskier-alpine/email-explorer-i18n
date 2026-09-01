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
import { roleOf } from "../roles";
import type { Env, Session } from "../types";

type AppContext = Context<{ Bindings: Env; Variables: { session?: Session } }>;

const ErrorResponseSchema = z.object({ error: z.string() });
const SuccessResponseSchema = z.object({ status: z.string() });

/**
 * An account as root sees it: who it is, what it may do, and which addresses
 * it looks after. No password, no session, nothing about the mail.
 */
const AccountSchema = z.object({
	id: z.string(),
	email: z.string(),
	role: z.enum(["root", "admin", "member"]),
	mailboxes: z.array(z.string()),
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
		summary: "List accounts and the mailboxes assigned to them (root only)",
		operationId: "listAccounts",
		tags: ["Root"],
		responses: {
			"200": {
				description: "Accounts",
				...contentJson(z.array(AccountSchema)),
			},
			...forbidden,
		},
	};

	async handle(c: AppContext) {
		const session = requireRoot(c);
		if (session instanceof Response) return session;

		const rootUserId = await authDO(c.env).getRootUserId();

		const users = await authDO(c.env).getUsers();
		const accounts = await Promise.all(
			users.map(async (user) => ({
				id: user.id,
				email: user.email,
				role: roleOf(user, rootUserId),
				mailboxes: (await authDO(c.env).getUserMailboxes(user.id)).map(
					(entry) => entry.mailboxId,
				),
				createdAt: user.createdAt,
			})),
		);
		return c.json(accounts);
	}
}

export class PostAccount extends OpenAPIRoute {
	schema = {
		summary: "Create an account (root only)",
		operationId: "createAccount",
		tags: ["Root"],
		request: {
			body: contentJson(
				z.object({ email: z.string().email(), password: z.string().min(8) }),
			),
		},
		responses: {
			"201": { description: "Created", ...contentJson(AccountSchema) },
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

		const { email, password } = (
			await this.getValidatedData<typeof this.schema>()
		).body;

		try {
			// Created as an administrator: this is the tier that owns
			// mailboxes. A member -- someone given access to a mailbox they do
			// not own -- is made by assigning a mailbox, not by creating an
			// account.
			const user = await authDO(c.env).register(email, password, true);
			return c.json(
				{
					id: user.id,
					email: user.email,
					role: "admin",
					mailboxes: [],
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
		summary: "Set an account's password (root only)",
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

export class DeleteAccount extends OpenAPIRoute {
	schema = {
		summary: "Delete an account (root only)",
		operationId: "deleteAccount",
		tags: ["Root"],
		request: { params: z.object({ userId: z.string() }) },
		responses: {
			"204": { description: "Deleted" },
			"404": { description: "Not found", ...contentJson(ErrorResponseSchema) },
			"409": {
				description: "Would leave no administrator",
				...contentJson(ErrorResponseSchema),
			},
			...forbidden,
		},
	};

	async handle(c: AppContext) {
		const session = requireRoot(c);
		if (session instanceof Response) return session;

		const { userId } = (await this.getValidatedData<typeof this.schema>())
			.params;

		// Root deleting itself would take the account list with it, and root
		// is not recreatable from inside the application.
		if (userId === session.userId) {
			return c.json({ error: "Cannot delete the root account" }, 409);
		}

		const result = await authDO(c.env).deleteUser(userId);
		if (result === "not-found") return c.json({ error: "Not found" }, 404);
		if (result === "last-admin") {
			return c.json({ error: "Cannot remove the last administrator" }, 409);
		}
		return c.body(null, 204);
	}
}

export class PostAccountMailbox extends OpenAPIRoute {
	schema = {
		summary: "Assign a mailbox to an account (root only)",
		operationId: "assignMailbox",
		tags: ["Root"],
		request: {
			params: z.object({ userId: z.string() }),
			body: contentJson(
				z.object({
					mailboxId: z.string(),
					role: z.enum(["owner", "admin", "write", "read"]).default("owner"),
				}),
			),
		},
		responses: {
			"200": { description: "Assigned", ...contentJson(SuccessResponseSchema) },
			"404": { description: "Not found", ...contentJson(ErrorResponseSchema) },
			...forbidden,
		},
	};

	async handle(c: AppContext) {
		const session = requireRoot(c);
		if (session instanceof Response) return session;

		const data = await this.getValidatedData<typeof this.schema>();
		// Checked because a grant on a mailbox that does not exist is a row
		// nothing will ever clean up, and a typo that looks like it worked.
		if (!(await c.env.BUCKET.head(`mailboxes/${data.body.mailboxId}.json`))) {
			return c.json({ error: "Not found" }, 404);
		}
		await authDO(c.env).grantMailboxAccess(
			data.params.userId,
			data.body.mailboxId,
			data.body.role,
		);
		return c.json({ status: "assigned" });
	}
}

export class DeleteAccountMailbox extends OpenAPIRoute {
	schema = {
		summary: "Take a mailbox away from an account (root only)",
		operationId: "unassignMailbox",
		tags: ["Root"],
		request: {
			params: z.object({ userId: z.string(), mailboxId: z.string() }),
		},
		responses: {
			"204": { description: "Unassigned" },
			...forbidden,
		},
	};

	async handle(c: AppContext) {
		const session = requireRoot(c);
		if (session instanceof Response) return session;

		const { userId, mailboxId } = (
			await this.getValidatedData<typeof this.schema>()
		).params;
		// Only the assignment goes. The mailbox and its mail are untouched:
		// taking an address away from a person must never be a way to delete
		// the mail in it.
		await authDO(c.env).revokeMailboxAccess(userId, mailboxId);
		return c.body(null, 204);
	}
}

/**
 * Names the first root, from the admin screen, once.
 *
 * Deliberately **not** a root-only route -- there is no root yet, so a
 * root-only route could never be reached and the tier could never come into
 * existence without going outside the application. An administrator may do
 * it, which grants them nothing: an administrator can already make and unmake
 * administrators. The Durable Object refuses if a root already exists, so
 * this is a door that opens once and then is not there.
 */
export class PostClaimRoot extends OpenAPIRoute {
	schema = {
		summary: "Name the first root account (admin only, once)",
		operationId: "claimRoot",
		tags: ["Root"],
		request: { body: contentJson(z.object({ userId: z.string() })) },
		responses: {
			"200": { description: "Named", ...contentJson(SuccessResponseSchema) },
			"404": { description: "Not found", ...contentJson(ErrorResponseSchema) },
			"409": {
				description: "There is already a root account",
				...contentJson(ErrorResponseSchema),
			},
			"401": {
				description: "Unauthorized",
				...contentJson(ErrorResponseSchema),
			},
			"403": { description: "Admin only", ...contentJson(ErrorResponseSchema) },
		},
	};

	async handle(c: AppContext) {
		const session = c.get("session");
		if (!session) return c.json({ error: "Unauthorized" }, 401);
		if (!session.isAdmin) {
			return c.json({ error: "Admin privileges required" }, 403);
		}

		const { userId } = (await this.getValidatedData<typeof this.schema>()).body;
		const result = await authDO(c.env).claimRoot(userId);
		if (result === "not-found") return c.json({ error: "Not found" }, 404);
		if (result === "taken") {
			return c.json({ error: "A root account already exists" }, 409);
		}
		return c.json({ status: "assigned" });
	}
}

/**
 * Hands the role to another account.
 *
 * The handover path and the recovery path at once, which is why it is here
 * rather than left to an edit of the storage. Root loses the account screen
 * the moment this returns.
 */
export class PostTransferRoot extends OpenAPIRoute {
	schema = {
		summary: "Hand the root role to another account (root only)",
		operationId: "transferRoot",
		tags: ["Root"],
		request: { body: contentJson(z.object({ userId: z.string() })) },
		responses: {
			"200": {
				description: "Transferred",
				...contentJson(SuccessResponseSchema),
			},
			"404": { description: "Not found", ...contentJson(ErrorResponseSchema) },
			...forbidden,
		},
	};

	async handle(c: AppContext) {
		const session = requireRoot(c);
		if (session instanceof Response) return session;

		const { userId } = (await this.getValidatedData<typeof this.schema>()).body;
		if (userId === session.userId) return c.json({ status: "unchanged" });

		const result = await authDO(c.env).transferRoot(userId);
		if (result === "not-found") return c.json({ error: "Not found" }, 404);
		return c.json({ status: "transferred" });
	}
}

/**
 * Whether this deployment has a root account yet, for the admin screen to
 * know whether to offer the one-time setup. Admin-only, and it returns an id
 * and nothing else -- who root is, is already visible in the account list.
 */
export class GetRootAccount extends OpenAPIRoute {
	schema = {
		summary: "Which account holds the root role (admin only)",
		operationId: "getRootAccount",
		tags: ["Root"],
		responses: {
			"200": {
				description: "The root account, or null",
				...contentJson(z.object({ userId: z.string().nullable() })),
			},
			"401": {
				description: "Unauthorized",
				...contentJson(ErrorResponseSchema),
			},
			"403": { description: "Admin only", ...contentJson(ErrorResponseSchema) },
		},
	};

	async handle(c: AppContext) {
		const session = c.get("session");
		if (!session) return c.json({ error: "Unauthorized" }, 401);
		if (!session.isAdmin) {
			return c.json({ error: "Admin privileges required" }, 403);
		}
		return c.json({ userId: await authDO(c.env).getRootUserId() });
	}
}
