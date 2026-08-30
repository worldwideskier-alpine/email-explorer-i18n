import { contentJson, OpenAPIRoute } from "chanfana";
import type { Context } from "hono";
import { z } from "zod";
import { buildEmailChangeEmail, MAIL_LOCALES } from "../mail-templates";
import { sendEmail } from "../resend";
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
	createdAt: z.number(),
	updatedAt: z.number(),
});

const ErrorResponseSchema = z.object({
	error: z.string(),
});

const SuccessResponseSchema = z.object({
	status: z.string(),
});

const GrantAccessRequestSchema = z.object({
	userId: z.string(),
	mailboxId: z.string(),
	role: z.enum(["owner", "admin", "write", "read"]),
});

const RevokeAccessRequestSchema = z.object({
	userId: z.string(),
	mailboxId: z.string(),
});

const UpdateUserRequestSchema = z.object({
	isAdmin: z.boolean().optional(),
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

		return c.json(session);
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
		if (!c.env.config?.accountRecovery) {
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
			await sendEmail(c.env, {
				from: c.env.config.accountRecovery.fromEmail,
				to: address,
				subject: message.subject,
				html: message.html,
				text: message.text,
			});
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

// Admin routes
export class PostAdminRegister extends OpenAPIRoute {
	schema = {
		summary: "Register a new user (admin only)",
		operationId: "adminRegister",
		tags: ["Auth - Admin"],
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

		if (!session.isAdmin) {
			return c.json({ error: "Admin privileges required" }, 403);
		}

		const data = await this.getValidatedData<typeof this.schema>();
		const { email, password } = data.body;

		const authDO = getAuthDO(c.env);

		try {
			const user = await authDO.register(email, password, false);
			return c.json(user, 201);
		} catch (error: any) {
			if (error.message?.includes("UNIQUE constraint failed")) {
				return c.json({ error: "Email already registered" }, 400);
			}
			return c.json({ error: "Registration failed" }, 400);
		}
	}
}

export class GetUsers extends OpenAPIRoute {
	schema = {
		summary: "Get all users (admin only)",
		operationId: "getUsers",
		tags: ["Auth - Admin"],
		responses: {
			"200": {
				description: "List of users",
				...contentJson(z.array(UserResponseSchema)),
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

		if (!session.isAdmin) {
			return c.json({ error: "Admin privileges required" }, 403);
		}

		const authDO = getAuthDO(c.env);
		const users = await authDO.getUsers();

		return c.json(users);
	}
}

export class PutUser extends OpenAPIRoute {
	schema = {
		summary: "Update a user (admin only)",
		operationId: "updateUser",
		tags: ["Auth - Admin"],
		request: {
			params: z.object({
				userId: z.string(),
			}),
			body: contentJson(UpdateUserRequestSchema),
		},
		responses: {
			"200": {
				description: "User updated successfully",
				...contentJson(SuccessResponseSchema),
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

		if (!session.isAdmin) {
			return c.json({ error: "Admin privileges required" }, 403);
		}

		const data = await this.getValidatedData<typeof this.schema>();
		const { isAdmin } = data.body;
		if (isAdmin === undefined) {
			return c.json({ status: "updated" });
		}

		const userId = c.req.param("userId");
		const authDO = getAuthDO(c.env);
		const result = await authDO.setUserAdmin(userId, isAdmin);

		if (result === "not-found") {
			return c.json({ error: "User not found" }, 404);
		}
		if (result === "last-admin") {
			return c.json({ error: "Cannot remove the last administrator" }, 409);
		}
		return c.json({ status: "updated" });
	}
}

export class PostGrantAccess extends OpenAPIRoute {
	schema = {
		summary: "Grant mailbox access to a user (admin only)",
		operationId: "grantMailboxAccess",
		tags: ["Auth - Admin"],
		request: {
			body: contentJson(GrantAccessRequestSchema),
		},
		responses: {
			"200": {
				description: "Access granted successfully",
				...contentJson(SuccessResponseSchema),
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

		if (!session.isAdmin) {
			return c.json({ error: "Admin privileges required" }, 403);
		}

		const data = await this.getValidatedData<typeof this.schema>();
		const { userId, mailboxId, role } = data.body;

		const authDO = getAuthDO(c.env);
		await authDO.grantMailboxAccess(userId, mailboxId, role);

		return c.json({ status: "access granted" });
	}
}

export class PostRevokeAccess extends OpenAPIRoute {
	schema = {
		summary: "Revoke mailbox access from a user (admin only)",
		operationId: "revokeMailboxAccess",
		tags: ["Auth - Admin"],
		request: {
			body: contentJson(RevokeAccessRequestSchema),
		},
		responses: {
			"200": {
				description: "Access revoked successfully",
				...contentJson(SuccessResponseSchema),
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

		if (!session.isAdmin) {
			return c.json({ error: "Admin privileges required" }, 403);
		}

		const data = await this.getValidatedData<typeof this.schema>();
		const { userId, mailboxId } = data.body;

		const authDO = getAuthDO(c.env);
		await authDO.revokeMailboxAccess(userId, mailboxId);

		return c.json({ status: "access revoked" });
	}
}
