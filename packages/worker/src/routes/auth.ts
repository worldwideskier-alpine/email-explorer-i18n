import { contentJson, OpenAPIRoute } from "chanfana";
import type { Context } from "hono";
import { z } from "zod";
import { recoveryFromEmail } from "../deployment-config";
import {
	deviceCookie,
	deviceHash,
	deviceTokensOf,
	newDeviceToken,
} from "../login-device";
import { buildEmailChangeEmail, MAIL_LOCALES } from "../mail-templates";
import { sendEmail } from "../resend";
import { roleOf } from "../roles";
import {
	accountChangeThrottleRules,
	clientIp,
	registerThrottleRules,
	retryAfterSeconds,
} from "../throttle";
import { turnstileRefusal } from "../turnstile";
import type { Env, Session } from "../types";

type AppContext = Context<{ Bindings: Env; Variables: { session?: Session } }>;

// Schemas
const RegisterRequestSchema = z.object({
	email: z.string().email(),
	password: z.string().min(8),
	// From the Turnstile widget, when root has turned it on; see turnstile.ts.
	turnstileToken: z.string().optional(),
});

/**
 * Asks the signed-in person for their current password, under the same limit
 * as changing it. Null when it is right; otherwise the response to send.
 *
 * Adding or removing a sign-in address is an act that outlasts the session it
 * was done from. Without this, somebody holding a stolen session added a
 * login of their own to the owner's person -- a password they chose, which a
 * reset of the owner's password does not touch -- and kept the account after
 * every session had been ended. On root, that was the deployment for good.
 */
export async function proveCurrentPassword(
	c: AppContext,
	session: Session,
	currentPassword: string,
): Promise<Response | null> {
	const authDO = getAuthDO(c.env);
	const rules = accountChangeThrottleRules(
		session.userId,
		clientIp(c.req.raw),
		{ sendsMail: false },
	);
	const retryAfterMs = await authDO.throttleTake(rules);
	if (retryAfterMs > 0) {
		c.header("Retry-After", String(retryAfterSeconds(retryAfterMs)));
		return c.json({ error: "Too many attempts" }, 429);
	}
	if (!(await authDO.verifyUserPassword(session.userId, currentPassword))) {
		// 403, not 401: the session is fine, the password in the body is not.
		return c.json({ error: "Current password is incorrect" }, 403);
	}
	await authDO.throttleSettle(rules);
	return null;
}

const LoginRequestSchema = z.object({
	email: z.string().email(),
	password: z.string(),
	turnstileToken: z.string().optional(),
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

/**
 * The session token a request carries: the bearer token, or else the
 * `session` cookie.
 *
 * The cookie is found by its whole name. `/session=([^;]+)/` also matched the
 * end of any other cookie's name -- `user_session=`, `csession=` -- so another
 * application on the same site setting one ahead of ours made every request
 * here 401, and a sign-out ended that other token while ours lived on.
 */
export function sessionTokenFrom(
	authorization: string | null | undefined,
	cookie: string | null | undefined,
): string | null {
	if (authorization?.startsWith("Bearer ")) {
		return authorization.substring(7);
	}
	for (const pair of (cookie ?? "").split(";")) {
		const at = pair.indexOf("=");
		if (at > 0 && pair.slice(0, at).trim() === "session") {
			return pair.slice(at + 1).trim() || null;
		}
	}
	return null;
}

/**
 * The only requests a session cookie signs in: reading an attachment, and
 * the API's own documentation. Everything else needs the bearer token.
 *
 * A message is shown in a frame of this page's origin, so what it names by a
 * path here goes out with the reader's cookie -- but never with the bearer
 * token, which only the dashboard's own script adds. Measured in Chromium, in
 * the inbox: `<link rel=prefetch>` at the export answered the mailbox as
 * mbox, and `<a ping>` at the logout signed the reader out when the link was
 * tapped. The frame's rules take those out, and a rule missed or a browser
 * feature not yet invented would undo that; this does not depend on either.
 *
 * What the cookie is still for is what cannot carry a header: an inline
 * picture in a message (an attachment, `<img src>`) and `/docs` opened by
 * hand, with the `/openapi.json` it fetches. All of them are reads, of what
 * the reader could see anyway.
 */
function cookieSignsIn(request: Request): boolean {
	if (request.method !== "GET") return false;
	const { pathname } = new URL(request.url);
	return (
		ATTACHMENT_PATH.test(pathname) ||
		pathname === "/docs" ||
		pathname === "/openapi.json"
	);
}

/** The one API a page may load as a subresource: an attachment, by path. */
export const ATTACHMENT_PATH =
	/^\/api\/v1\/mailboxes\/[^/]+\/emails\/[^/]+\/attachments\/[^/]+$/;

/** The session token this request is signed in with; see cookieSignsIn. */
export function sessionTokenOf(request: Request): string | null {
	return sessionTokenFrom(
		request.headers.get("Authorization"),
		cookieSignsIn(request) ? request.headers.get("Cookie") : null,
	);
}

function getSessionToken(c: AppContext): string | null {
	return sessionTokenOf(c.req.raw);
}

/**
 * Hands a new session to the browser: the cookie, and the session with its
 * role, which the dashboard decides which screen to open from before it has
 * asked anything else.
 */
async function startSession(
	c: AppContext,
	authDO: ReturnType<typeof getAuthDO>,
	session: Awaited<ReturnType<ReturnType<typeof getAuthDO>["login"]>>,
) {
	if (!session) return null;
	const cookie = `session=${session.id}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${30 * 24 * 60 * 60}`;
	c.header("Set-Cookie", cookie);
	const [personId, rootPersonId] = await Promise.all([
		authDO.getPersonId(session.userId),
		authDO.getRootPersonId(),
	]);
	return { ...session, role: roleOf(personId, rootPersonId) };
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
				description: "User registered and signed in",
				...contentJson(
					UserResponseSchema.extend({
						session: SessionResponseSchema.extend({
							role: z.enum(["root", "admin"]),
						}).nullable(),
					}),
				),
			},
			"400": {
				description: "Bad request",
				...contentJson(ErrorResponseSchema),
			},
			"403": {
				description: "Registration disabled, or the bot check failed",
				...contentJson(ErrorResponseSchema),
			},
		},
	};

	async handle(c: AppContext) {
		const data = await this.getValidatedData<typeof this.schema>();
		const { email, password, turnstileToken } = data.body;

		const authDO = getAuthDO(c.env);
		const registerEnabled = c.env.config?.auth?.registerEnabled;

		// Check registration eligibility
		if (registerEnabled === false) {
			return c.json({ error: "Registration is disabled" }, 403);
		}

		const refused = await turnstileRefusal(c.env, c.req.raw, turnstileToken);
		if (refused) return refused;

		// After Turnstile, as for sign-in: a request without a good token
		// spends nobody's allowance.
		const retryAfterMs = await authDO.throttleTake(
			registerThrottleRules(clientIp(c.req.raw)),
		);
		if (retryAfterMs > 0) {
			c.header("Retry-After", String(retryAfterSeconds(retryAfterMs)));
			return c.json({ error: "Too many attempts" }, 429);
		}

		try {
			// Smart mode (the setting left unset) opens the form to the first
			// account only. That account is root; everything else follows from
			// it -- root makes the administrators, administrators make the
			// mailboxes. Both are decided inside registerFromForm, in the step
			// that inserts the account, so two registrations at once cannot
			// both be first.
			const user = await authDO.registerFromForm(
				email,
				password,
				registerEnabled === undefined,
			);
			if (user === "closed") {
				return c.json(
					{
						error: "Registration is closed. Contact an administrator.",
					},
					403,
				);
			}

			// Signed in at once, which the form did by asking /login next. With
			// Turnstile on that second request would need a second token, and
			// the one the widget gave has just been spent here. The browser
			// that registered is the first one this login trusts.
			const deviceToken = newDeviceToken();
			const session = await startSession(
				c,
				authDO,
				await authDO.login(email, password, {
					trusted: null,
					grant: await deviceHash(deviceToken),
				}),
			);
			if (session) {
				c.header("Set-Cookie", deviceCookie(deviceToken), { append: true });
			}
			// The role, as every other route that answers with a user gives
			// it; the schema said so and this one left it out.
			const role =
				session?.role ??
				roleOf(
					await authDO.getPersonId(user.id),
					await authDO.getRootPersonId(),
				);
			return c.json({ ...user, role, session }, 201);
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
			"403": {
				description: "The bot check failed",
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
		const { email, password, turnstileToken } = data.body;

		// Before the throttle; see turnstileRefusal.
		const refused = await turnstileRefusal(c.env, c.req.raw, turnstileToken);
		if (refused) return refused;

		const authDO = getAuthDO(c.env);
		const presented = await Promise.all(
			deviceTokensOf(c.req.raw).map(deviceHash),
		);

		// The attempt is counted before the password is checked, in the same
		// call that checks the lock; see throttleTake for why. That call also
		// decides whether this browser is one the login trusts, which decides
		// what the attempt is counted on (loginThrottleRules).
		const { retryAfterMs, rules, trusted } = await authDO.loginTake(
			email,
			clientIp(c.req.raw),
			presented,
		);
		if (retryAfterMs > 0) {
			c.header("Retry-After", String(retryAfterSeconds(retryAfterMs)));
			return c.json({ error: "Too many failed attempts" }, 429);
		}

		// A new token at every sign-in, granted inside login, in the call
		// that verifies the password; the one presented is retired there.
		const deviceToken = newDeviceToken();
		const session = await authDO.login(email, password, {
			trusted,
			grant: await deviceHash(deviceToken),
		});

		if (!session) {
			return c.json({ error: "Invalid credentials" }, 401);
		}

		// Knowing the password clears this address's slate, so a user who
		// mistyped a few times and then got it right is not left sitting on a
		// near-lockout. The address's own IP only gets this attempt back. A
		// trusted browser's success clears its own key and not the address's:
		// a stranger locked out of the address stays locked out.
		await authDO.throttleSettle(rules);

		const body = await startSession(c, authDO, session);
		c.header("Set-Cookie", deviceCookie(deviceToken), { append: true });
		return c.json(body);
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
			{ sendsMail: false },
		);
		const retryAfterMs = await authDO.throttleTake(rules);
		if (retryAfterMs > 0) {
			c.header("Retry-After", String(retryAfterSeconds(retryAfterMs)));
			return c.json({ error: "Too many attempts" }, 429);
		}

		// The current session is kept so the user is not signed out of the tab
		// they are using; every other one is dropped inside changePassword,
		// with every browser's standing. This browser is handed a new one,
		// under the new password, in the same call.
		const deviceToken = newDeviceToken();
		const changed = await authDO.changePassword(
			session.userId,
			currentPassword,
			newPassword,
			session.id,
			await deviceHash(deviceToken),
		);
		if (!changed) {
			// 403, not 401: the session is fine, the password in the body is
			// not. A 401 would have the dashboard sign the user out for a typo.
			return c.json({ error: "Current password is incorrect" }, 403);
		}

		await authDO.throttleSettle(rules);
		c.header("Set-Cookie", deviceCookie(deviceToken), { append: true });
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
		const fromEmail = await recoveryFromEmail(c.env);
		if (!fromEmail) {
			return c.json({ error: "Account recovery is not enabled" }, 503);
		}

		const data = await this.getValidatedData<typeof this.schema>();
		const { currentPassword, newEmail, locale } = data.body;

		const authDO = getAuthDO(c.env);
		const rules = accountChangeThrottleRules(
			session.userId,
			clientIp(c.req.raw),
			{ sendsMail: true },
		);
		const retryAfterMs = await authDO.throttleTake(rules);
		if (retryAfterMs > 0) {
			c.header("Retry-After", String(retryAfterSeconds(retryAfterMs)));
			return c.json({ error: "Too many attempts" }, 429);
		}

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
		// Bound to the password and address as they are now, so that
		// changing either -- a password change, a reset, another address
		// change -- takes every link issued before it out of use.
		const stamp = await authDO.emailChangeStamp(session.userId);
		if (!stamp) {
			return c.json({ error: "Unauthorized" }, 401);
		}
		await c.env.BUCKET.put(
			`email-change-tokens/${token}.json`,
			JSON.stringify({
				userId: session.userId,
				newEmail: address,
				expiresAt,
				stamp,
			}),
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

		// Clears the guessing count, as a right password does anywhere, and
		// leaves the mail count as it is: see accountChangeThrottleRules.
		await authDO.throttleSettle(rules);
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
			stamp?: string;
		}>();
		// A link from before links were bound to the password has nothing to
		// check it by, and is treated as the stale link it may be.
		if (pending.expiresAt < Date.now() || !pending.stamp) {
			await c.env.BUCKET.delete(key);
			return c.json({ error: "Invalid or expired token" }, 401);
		}

		const authDO = getAuthDO(c.env);
		const outcome = await authDO.confirmEmailChange(
			pending.userId,
			pending.newEmail,
			pending.stamp,
		);
		await c.env.BUCKET.delete(key);

		// The login is gone, or its password or address changed after the
		// link went out: to whoever holds the link, the same as expired.
		if (outcome === "stale") {
			return c.json({ error: "Invalid or expired token" }, 401);
		}
		if (outcome === "taken") {
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
			body: contentJson(
				RegisterRequestSchema.extend({ currentPassword: z.string() }),
			),
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
		const { email, password, currentPassword } = data.body;

		const refused = await proveCurrentPassword(c, session, currentPassword);
		if (refused) return refused;

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
		request: {
			params: z.object({ userId: z.string() }),
			body: contentJson(z.object({ currentPassword: z.string() })),
		},
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

		const data = await this.getValidatedData<typeof this.schema>();
		const userId = data.params.userId;
		const authDO = getAuthDO(c.env);

		const refused = await proveCurrentPassword(
			c,
			session,
			data.body.currentPassword,
		);
		if (refused) return refused;

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
