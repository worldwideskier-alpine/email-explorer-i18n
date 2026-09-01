import { contentJson, OpenAPIRoute } from "chanfana";
import type { Context } from "hono";
import { z } from "zod";
import { recoveryFromEmail } from "../deployment-config";
import { buildEmailChangeEmail, MAIL_LOCALES } from "../mail-templates";
import { sendEmail } from "../resend";
import { roleOf } from "../roles";
import {
	accountChangeThrottleRules,
	clientIp,
	loginThrottleRules,
	retryAfterSeconds,
	throttleKeys,
} from "../throttle";
import type { Env, Session } from "../types";

type AppContext = Context<{ Bindings: Env; Variables: { session?: Session } }>;

// Schemas
const RegisterRequestSchema = z.object({
	email: z.string().email(),
	password: z.string().min(8),
});

const LoginRequestSchema = z.object({
	email: z.string().email(),
	password: z.string(),
});

const SessionResponseSchema = z.object({
	id: z.string(),
	userId: z.string(),
	email: z.string(),
	isAdmin: z.boolean(),
	expiresAt: z.number(),
});

const UserResponseSchema = z.object({
	id: z.string(),
	email: z.string(),
	isAdmin: z.boolean(),
	// The role, which belongs to the person rather than to this login. A flag
	// on the row cannot say it: root is deliberately not an administrator, so
	// a screen reading the flag showed the top account as the bottom role.
	role: z.enum(["root", "admin"]),
	createdAt: z.number(),
	updatedAt: z.number(),
});

const ErrorResponseSchema = z.object({
	error: z.string(),
});

const SuccessResponseSchema = z.object({
	status: z.string(),
});

const ChangePasswordRequestSchema = z.object({
	currentPassword: z.string(),
	newPassword: z.string().min(8),
});

const ChangeEmailRequestSchema = z.object({
	currentPassword: z.string(),
	newEmail: z.string().email(),
	// Which language to write the confirmation mail in; see MAIL_LOCALES. As
	// with the reset mail, a code missing from that list is rejected here with
	// a 400 rather than falling back, so the list has to match the picker.
	locale: z.enum(MAIL_LOCALES).optional(),
});

const ConfirmEmailChangeRequestSchema = z.object({
	token: z.string(),
});

// Helper function to get auth DO
function getAuthDO(env: Env) {
	const authId = env.MAILBOX.idFromName("AUTH");
	return env.MAILBOX.get(authId);
}

// Helper function to extract session token
function getSessionToken(c: AppContext): string | null {
	// Try Authorization header first
	const authHeader = c.req.header("Authorization");
	if (authHeader?.startsWith("Bearer ")) {
		return authHeader.substring(7);
	}

	// Try cookie
	const cookie = c.req.header("Cookie");
	if (cookie) {
		const match = cookie.match(/session=([^;]+)/);
		return match ? match[1] : null;
	}

	return null;
}

// Public routes
export class PostRegister extends OpenAPIRoute {
	schema = {
		summary: "Register a new user",
		operationId: "register",
		tags: ["Auth"],
		request: {
			body: contentJson(RegisterRequestSchema),
		},
		responses: {
			"201": {
				description: "User registered successfully",
				...contentJson(UserResponseSchema),
			},
			"400": {
				description: "Bad request",
				...contentJson(ErrorResponseSchema),
			},
			"403": {
				description: "Registration disabled",
				...contentJson(ErrorResponseSchema),
			},
		},
	};

	async handle(c: AppContext) {
		const data = await this.getValidatedData<typeof this.schema>();
		const { email, password } = data.body;

		const authDO = getAuthDO(c.env);
		const registerEnabled = c.env.config?.auth?.registerEnabled;

		// Check registration eligibility
		if (registerEnabled === false) {
			return c.json({ error: "Registration is disabled" }, 403);
		}

		// Smart mode: Allow first user only
		if (registerEnabled === undefined) {
			const hasUsers = await authDO.hasUsers();
			if (hasUsers) {
				return c.json(
					{
						error: "Registration is closed. Contact an administrator.",
					},
					403,
				);
			}
		}

		try {
			// Check if this is the first user
			const isFirstUser = !(await authDO.hasUsers());
			const user = await authDO.register(email, password, isFirstUser);

			// The first account to register is the root account, and that is
			// the only way one comes into being. Not a button somewhere that
			// an administrator can press: on a public deployment that button
			// is "any administrator may seize the tier above them, once", and
			// there is no reading of it that is safe.
			//
			// Everything else follows from here -- root makes the
			// administrators, administrators make the mailboxes.
			if (isFirstUser) await authDO.claimRoot(user.id);

			return c.json(user, 201);
		} catch (error: any) {
			if (error.message?.includes("UNIQUE constraint failed")) {
				return c.json({ error: "Email already registered" }, 400);
			}
			return c.json({ error: "Registration failed" }, 400);
		}
	}
}

export class PostLogin extends OpenAPIRoute {
	schema = {
		summary: "Login",
		operationId: "login",
		tags: ["Auth"],
		request: {
			body: contentJson(LoginRequestSchema),
		},
		responses: {
			"200": {
				description: "Login successful",
				...contentJson(SessionResponseSchema),
			},
			"401": {
				description: "Unauthorized",
				...contentJson(ErrorResponseSchema),
			},
			"429": {
				description: "Too many failed attempts",
				...contentJson(ErrorResponseSchema),
			},
		},
	};

	async handle(c: AppContext) {
		const data = await this.getValidatedData<typeof this.schema>();
		const { email, password } = data.body;

		const authDO = getAuthDO(c.env);
		const rules = loginThrottleRules(email, clientIp(c.req.raw));

		const retryAfterMs = await authDO.throttleRetryAfter(throttleKeys(rules));
		if (retryAfterMs > 0) {
			c.header("Retry-After", String(retryAfterSeconds(retryAfterMs)));
			return c.json({ error: "Too many failed attempts" }, 429);
		}

		const session = await authDO.login(email, password);

		if (!session) {
			await authDO.throttleRecord(rules);
			return c.json({ error: "Invalid credentials" }, 401);
		}

		// Knowing the password clears the slate, so a user who mistyped a few
		// times and then got it right is not left sitting on a near-lockout.
		await authDO.throttleReset(throttleKeys(rules));

		// Set cookie
		const cookie = `session=${session.id}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${30 * 24 * 60 * 60}`;
		c.header("Set-Cookie", cookie);

		// The role travels with the session from here on: the dashboard
		// decides which screen to open from this response, before it has
		// asked anything else.
		const [personId, rootPersonId] = await Promise.all([
			authDO.getPersonId(session.userId),
			authDO.getRootPersonId(),
		]);
		return c.json({ ...session, role: roleOf(personId, rootPersonId) });
	}
}

export class PostChangePassword extends OpenAPIRoute {
	schema = {
		summary: "Change your own password",
		operationId: "changePassword",
		tags: ["Auth"],
		request: {
			body: contentJson(ChangePasswordRequestSchema),
		},
		responses: {
			"200": {
				description: "Password changed",
				...contentJson(SuccessResponseSchema),
			},
			"401": {
				description: "Not signed in",
				...contentJson(ErrorResponseSchema),
			},
			"403": {
				description: "The current password is wrong",
				...contentJson(ErrorResponseSchema),
			},
			"429": {
				description: "Too many attempts",
				...contentJson(ErrorResponseSchema),
			},
		},
	};

	async handle(c: AppContext) {
		const session = c.get("session");
		if (!session) {
			return c.json({ error: "Unauthorized" }, 401);
		}

		const data = await this.getValidatedData<typeof this.schema>();
		const { currentPassword, newPassword } = data.body;

		const authDO = getAuthDO(c.env);
		const rules = accountChangeThrottleRules(
			session.userId,
			clientIp(c.req.raw),
		);
		const retryAfterMs = await authDO.throttleRetryAfter(throttleKeys(rules));
		if (retryAfterMs > 0) {
			c.header("Retry-After", String(retryAfterSeconds(retryAfterMs)));
			return c.json({ error: "Too many attempts" }, 429);
		}

		// The current session is kept so the user is not signed out of the tab
		// they are using; every other one is dropped inside changePassword.
		const changed = await authDO.changePassword(
			session.userId,
			currentPassword,
			newPassword,
			session.id,
		);
		if (!changed) {
			await authDO.throttleRecord(rules);
			// 403, not 401: the session is fine, the password in the body is
			// not. A 401 would have the dashboard sign the user out for a typo.
			return c.json({ error: "Current password is incorrect" }, 403);
		}

		await authDO.throttleReset(throttleKeys(rules));
		return c.json({ status: "Password changed" });
	}
}

export class PostChangeEmail extends OpenAPIRoute {
	schema = {
		summary: "Request a change of your sign-in address",
		operationId: "changeEmail",
		tags: ["Auth"],
		request: {
			body: contentJson(ChangeEmailRequestSchema),
		},
		responses: {
			"200": {
				description: "Confirmation email sent to the new address",
				...contentJson(SuccessResponseSchema),
			},
			"401": {
				description: "Not signed in",
				...contentJson(ErrorResponseSchema),
			},
			"403": {
				description: "The current password is wrong",
				...contentJson(ErrorResponseSchema),
			},
			"409": {
				description: "That address already belongs to an account",
				...contentJson(ErrorResponseSchema),
			},
			"429": {
				description: "Too many attempts",
				...contentJson(ErrorResponseSchema),
			},
			"503": {
				description: "Account recovery (outbound mail) is not enabled",
				...contentJson(ErrorResponseSchema),
			},
		},
	};

	async handle(c: AppContext) {
		const session = c.get("session");
		if (!session) {
			return c.json({ error: "Unauthorized" }, 401);
		}
		// The confirmation link is the whole mechanism, and it goes out over
		// the same sender the recovery mail uses. Without that configured
		// there is no way to prove the new address is reachable.
		const fromEmail = recoveryFromEmail(c.env);
		if (!fromEmail) {
			return c.json({ error: "Account recovery is not enabled" }, 503);
		}

		const data = await this.getValidatedData<typeof this.schema>();
		const { currentPassword, newEmail, locale } = data.body;

		const authDO = getAuthDO(c.env);
		const rules = accountChangeThrottleRules(
			session.userId,
			clientIp(c.req.raw),
		);
		const retryAfterMs = await authDO.throttleRetryAfter(throttleKeys(rules));
		if (retryAfterMs > 0) {
			c.header("Retry-After", String(retryAfterSeconds(retryAfterMs)));
			return c.json({ error: "Too many attempts" }, 429);
		}
		await authDO.throttleRecord(rules);

		if (!(await authDO.verifyUserPassword(session.userId, currentPassword))) {
			return c.json({ error: "Current password is incorrect" }, 403);
		}

		const address = newEmail.trim().toLowerCase();
		if (await authDO.getUserByEmail(address)) {
			return c.json({ error: "Email already registered" }, 409);
		}

		// Nothing is changed yet. The address only becomes the sign-in address
		// once someone reading it follows the link, which is what proves it is
		// reachable -- the point of the whole exercise being that the address
		// must still work when the password has been forgotten.
		const token = crypto.randomUUID();
		const expiresAt = Date.now() + 3600000; // 1 hour
		await c.env.BUCKET.put(
			`email-change-tokens/${token}.json`,
			JSON.stringify({ userId: session.userId, newEmail: address, expiresAt }),
			{ customMetadata: { expiresAt: expiresAt.toString() } },
		);

		const link = `${new URL(c.req.url).origin}/confirm-email-change?token=${token}`;
		const message = buildEmailChangeEmail(locale, link);
		try {
			// The person changing their own address, so their own key.
			await sendEmail(
				c.env,
				{
					from: fromEmail,
					to: address,
					subject: message.subject,
					html: message.html,
					text: message.text,
				},
				session.personId,
			);
		} catch (e) {
			console.error("Failed to send address-change confirmation:", e);
			return c.json({ error: "Failed to send confirmation email" }, 500);
		}

		await authDO.throttleReset(throttleKeys(rules));
		return c.json({ status: "Confirmation email sent" });
	}
}

export class PostConfirmEmailChange extends OpenAPIRoute {
	schema = {
		summary: "Confirm a change of sign-in address",
		operationId: "confirmEmailChange",
		tags: ["Auth"],
		request: {
			body: contentJson(ConfirmEmailChangeRequestSchema),
		},
		responses: {
			"200": {
				description: "Sign-in address changed",
				...contentJson(SuccessResponseSchema),
			},
			"401": {
				description: "Invalid or expired token",
				...contentJson(ErrorResponseSchema),
			},
			"409": {
				description: "That address already belongs to an account",
				...contentJson(ErrorResponseSchema),
			},
		},
	};

	// Deliberately reachable without a session: the link is opened by whoever
	// can read the new address, who may well be on a device that has never
	// signed in. The token is the credential, and it took the current
	// password to have one issued.
	async handle(c: AppContext) {
		const data = await this.getValidatedData<typeof this.schema>();
		const { token } = data.body;

		const key = `email-change-tokens/${token}.json`;
		const stored = await c.env.BUCKET.get(key);
		if (!stored) {
			return c.json({ error: "Invalid or expired token" }, 401);
		}

		const pending = await stored.json<{
			userId: string;
			newEmail: string;
			expiresAt: number;
		}>();
		if (pending.expiresAt < Date.now()) {
			await c.env.BUCKET.delete(key);
			return c.json({ error: "Invalid or expired token" }, 401);
		}

		const authDO = getAuthDO(c.env);
		const applied = await authDO.updateUserEmail(
			pending.userId,
			pending.newEmail,
		);
		await c.env.BUCKET.delete(key);

		if (!applied) {
			return c.json({ error: "Email already registered" }, 409);
		}
		return c.json({ status: "Sign-in address changed" });
	}
}

export class PostLogout extends OpenAPIRoute {
	schema = {
		summary: "Logout",
		operationId: "logout",
		tags: ["Auth"],
		responses: {
			"200": {
				description: "Logout successful",
				...contentJson(SuccessResponseSchema),
			},
		},
	};

	async handle(c: AppContext) {
		const sessionToken = getSessionToken(c);
		if (sessionToken) {
			const authDO = getAuthDO(c.env);
			await authDO.logout(sessionToken);
		}

		// Clear cookie
		c.header(
			"Set-Cookie",
			"session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0",
		);

		return c.json({ status: "logged out" });
	}
}

export class GetMe extends OpenAPIRoute {
	schema = {
		summary: "Get current user",
		operationId: "getCurrentUser",
		tags: ["Auth"],
		responses: {
			"200": {
				description: "Current user session",
				...contentJson(SessionResponseSchema),
			},
			"401": {
				description: "Unauthorized",
				...contentJson(ErrorResponseSchema),
			},
		},
	};

	async handle(c: AppContext) {
		const session = c.get("session");
		if (!session) {
			return c.json({ error: "Unauthorized" }, 401);
		}
		return c.json(session);
	}
}

/**
 * Adds another address the same person can sign in with.
 *
 * Not "create a user". This used to make a separate account with the flag
 * off, which somebody then had to promote by hand -- two steps that produced
 * something the model has no word for, and whose only visible trace was a
 * role column showing accounts that were really one person as two kinds of
 * stranger.
 *
 * The addresses a person signs in with are equal: none is the original, and
 * losing one is why the others exist. So this adds a login to the person
 * making the request, and to nobody else. There is no form anywhere for
 * adding a login to somebody else's person -- an administrator's spare
 * addresses are their own business, and root does not reach into them.
 */
export class PostAdminRegister extends OpenAPIRoute {
	schema = {
		summary: "Add another login to your own account",
		operationId: "addOwnLogin",
		tags: ["Auth - Admin"],
		request: {
			body: contentJson(RegisterRequestSchema),
		},
		responses: {
			"201": {
				description: "Login added",
				...contentJson(UserResponseSchema),
			},
			"400": {
				description: "Bad request",
				...contentJson(ErrorResponseSchema),
			},
			"401": {
				description: "Unauthorized",
				...contentJson(ErrorResponseSchema),
			},
		},
	};

	async handle(c: AppContext) {
		const session = c.get("session");
		if (!session) return c.json({ error: "Unauthorized" }, 401);
		if (!session.personId) {
			return c.json({ error: "Account has no person" }, 409);
		}

		const data = await this.getValidatedData<typeof this.schema>();
		const { email, password } = data.body;

		try {
			const user = await getAuthDO(c.env).register(
				email,
				password,
				false,
				session.personId,
			);
			return c.json({ ...user, role: session.role ?? "admin" }, 201);
		} catch (error: any) {
			if (error.message?.includes("UNIQUE constraint failed")) {
				return c.json({ error: "Email already registered" }, 400);
			}
			return c.json({ error: "Registration failed" }, 400);
		}
	}
}

/**
 * The addresses the signed-in person can sign in with -- theirs and nobody
 * else's.
 *
 * It used to answer with every account in the deployment. On a deployment
 * with one person that reads as "my logins" and looks harmless; with two it
 * hands each of them the other's address, and it showed root's address to the
 * customers root can delete.
 */
export class GetUsers extends OpenAPIRoute {
	schema = {
		summary: "List your own logins",
		operationId: "getOwnLogins",
		tags: ["Auth - Admin"],
		responses: {
			"200": {
				description: "Your logins",
				...contentJson(z.array(UserResponseSchema)),
			},
			"401": {
				description: "Unauthorized",
				...contentJson(ErrorResponseSchema),
			},
		},
	};

	async handle(c: AppContext) {
		const session = c.get("session");
		if (!session) return c.json({ error: "Unauthorized" }, 401);
		if (!session.personId) return c.json([]);

		const users = await getAuthDO(c.env).listPersonLogins(session.personId);
		return c.json(
			users.map((user) => ({ ...user, role: session.role ?? "admin" })),
		);
	}
}

/**
 * Drops one of your own logins.
 *
 * How a spare is replaced: add the new address, then remove the old one. The
 * Durable Object refuses the last one, because a person with no way in is a
 * person nobody can reach.
 *
 * There is no route for deleting somebody else's login. Root deletes people
 * whole, and an administrator's spares are their own to manage.
 */
export class DeleteOwnLogin extends OpenAPIRoute {
	schema = {
		summary: "Remove one of your own logins",
		operationId: "deleteOwnLogin",
		tags: ["Auth - Admin"],
		request: { params: z.object({ userId: z.string() }) },
		responses: {
			"204": { description: "Removed" },
			"401": {
				description: "Unauthorized",
				...contentJson(ErrorResponseSchema),
			},
			"403": { description: "Not yours", ...contentJson(ErrorResponseSchema) },
			"409": {
				description: "That is the only way in",
				...contentJson(ErrorResponseSchema),
			},
		},
	};

	async handle(c: AppContext) {
		const session = c.get("session");
		if (!session) return c.json({ error: "Unauthorized" }, 401);

		const userId = c.req.param("userId");
		const authDO = getAuthDO(c.env);

		// Yours means: belonging to the same person. Not "any account", which
		// is what made the old admin screen able to reach strangers.
		const owner = await authDO.getPersonId(userId);
		if (!owner || owner !== session.personId) {
			return c.json({ error: "Not yours" }, 403);
		}

		const result = await authDO.deleteLogin(userId);
		if (result === "not-found") return c.json({ error: "Not found" }, 404);
		if (result === "last-login") {
			return c.json({ error: "That is the only way in" }, 409);
		}
		return c.body(null, 204);
	}
}
