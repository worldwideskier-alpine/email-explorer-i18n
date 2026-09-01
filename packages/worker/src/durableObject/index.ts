import { DurableObject } from "cloudflare:workers";
import { DOQB } from "workers-qb";
import { hashPassword, verifyPassword } from "../password";
import type { ThrottleRule } from "../throttle";
import type { Env, Session, User } from "../types";
import { authMigrations, mailboxMigrations } from "./migrations";

const ALLOWED_SORT_COLUMNS = [
	"id",
	"subject",
	"sender",
	"recipient",
	"date",
	"read",
	"starred",
] as const;

type SortColumn = (typeof ALLOWED_SORT_COLUMNS)[number];

interface GetEmailsOptions {
	folder?: string;
	page?: number;
	limit?: number;
	sortColumn?: SortColumn;
	sortDirection?: "ASC" | "DESC";
}

interface EmailData {
	id: string;
	subject: string;
	sender: string;
	recipient: string;
	cc?: string | null;
	bcc?: string | null;
	date: string;
	body: string;
	read?: boolean;
	starred?: boolean;
	in_reply_to?: string | null;
	email_references?: string | null;
	thread_id?: string | null;
}

interface AttachmentData {
	id: string;
	email_id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id?: string | null;
	disposition?: string | null;
}

export class MailboxDO extends DurableObject<Env> {
	declare __DURABLE_OBJECT_BRAND: never;
	#qb: DOQB;
	#isAuthDO: boolean;

	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
		this.#qb = new DOQB(this.ctx.storage.sql);
		// this.#qb.setDebugger(true);

		// Detect if this is the auth singleton
		// We use a marker in storage to identify the auth DO
		const authMarker = this.ctx.storage.sql
			.exec(
				"SELECT name FROM sqlite_master WHERE type='table' AND name='users'",
			)
			.toArray();
		const hasAuthTables = authMarker.length > 0;

		// Check if this is first initialization
		const isFirstInit =
			this.ctx.storage.sql
				.exec(
					"SELECT name FROM sqlite_master WHERE type='table' AND name='migrations'",
				)
				.toArray().length === 0;

		// If first init, check the ID to determine type
		// idFromName creates deterministic IDs, so we check if this ID matches the expected AUTH ID
		if (isFirstInit) {
			// Create a test ID to compare
			const testAuthId = env.MAILBOX.idFromName("AUTH");
			this.#isAuthDO = this.ctx.id.equals(testAuthId);
		} else {
			// On subsequent loads, check if auth tables exist
			this.#isAuthDO = hasAuthTables;
		}

		// Apply appropriate migrations
		if (this.#isAuthDO) {
			this.#qb.migrations({ migrations: authMigrations }).apply();
		} else {
			this.#qb.migrations({ migrations: mailboxMigrations }).apply();
		}
	}

	// Auth helper: generate session token
	#generateToken(): string {
		return crypto.randomUUID();
	}

	// Auth operation: check if any users exist
	async hasUsers(): Promise<boolean> {
		if (!this.#isAuthDO) return false;
		const result = this.#qb.select("users").fields(["COUNT(*) as count"]).one();
		return (result.results?.count as number) > 0;
	}

	// Auth operation: check if user is admin
	async isAdmin(userId: string): Promise<boolean> {
		if (!this.#isAuthDO) return false;
		const result = this.#qb
			.select("users")
			.fields(["is_admin"])
			.where("id = ?", userId)
			.one();
		return result.results?.is_admin === 1;
	}

	// Auth operation: register a user
	async register(
		email: string,
		password: string,
		isFirstUser = false,
	): Promise<User> {
		if (!this.#isAuthDO) throw new Error("Not an auth DO");

		const userId = crypto.randomUUID();
		const passwordHash = await hashPassword(password);
		const now = Date.now();

		this.#qb
			.insert({
				tableName: "users",
				data: {
					id: userId,
					email,
					password_hash: passwordHash,
					is_admin: isFirstUser ? 1 : 0,
					created_at: now,
					updated_at: now,
				},
			})
			.execute();

		return {
			id: userId,
			email,
			isAdmin: isFirstUser,
			createdAt: now,
			updatedAt: now,
		};
	}

	// Auth operation: login
	async login(email: string, password: string): Promise<Session | null> {
		if (!this.#isAuthDO) throw new Error("Not an auth DO");

		const result = this.#qb
			.select("users")
			.fields(["id", "email", "password_hash", "is_admin"])
			.where("email = ?", email)
			.one();

		if (!result.results) return null;

		const user = result.results;
		const { valid, needsRehash } = await verifyPassword(
			password,
			String(user.password_hash),
		);

		if (!valid) return null;

		// Create session (30 days expiry)
		const sessionId = this.#generateToken();
		const now = Date.now();
		const expiresAt = now + 30 * 24 * 60 * 60 * 1000;

		// A correct password is the only moment the plaintext is available, so
		// it is also the only moment an account still on the old unsalted
		// SHA-256 can be moved onto PBKDF2. Doing it here means every account
		// upgrades on its own next login, with nobody asked to reset anything.
		if (needsRehash) {
			this.#qb
				.update({
					tableName: "users",
					data: {
						password_hash: await hashPassword(password),
						updated_at: now,
					},
					where: { conditions: "id = ?", params: [String(user.id)] },
				})
				.execute();
		}

		this.#qb
			.insert({
				tableName: "sessions",
				data: {
					id: sessionId,
					user_id: String(user.id),
					expires_at: expiresAt,
					created_at: now,
				},
			})
			.execute();

		return {
			id: sessionId,
			userId: String(user.id),
			email: String(user.email),
			isAdmin: user.is_admin === 1,
			expiresAt,
		};
	}

	// Auth operation: validate session
	async validateSession(sessionId: string): Promise<Session | null> {
		if (!this.#isAuthDO) throw new Error("Not an auth DO");

		const result = this.#qb
			.select("sessions")
			.fields(["id", "user_id", "expires_at"])
			.where("id = ?", sessionId)
			.one();

		if (!result.results) return null;

		const session = result.results;
		const expiresAt = Number(session.expires_at);

		// Check if expired
		if (expiresAt < Date.now()) {
			this.#qb
				.delete({
					tableName: "sessions",
					where: {
						conditions: "id = ?",
						params: [sessionId],
					},
				})
				.execute();
			return null;
		}

		// Get user info
		const userResult = this.#qb
			.select("users")
			.fields(["email", "is_admin"])
			.where("id = ?", String(session.user_id))
			.one();

		if (!userResult.results) return null;

		return {
			id: String(session.id),
			userId: String(session.user_id),
			email: String(userResult.results.email),
			isAdmin: userResult.results.is_admin === 1,
			expiresAt,
		};
	}

	// Auth operation: logout
	async logout(sessionId: string): Promise<boolean> {
		if (!this.#isAuthDO) throw new Error("Not an auth DO");

		this.#qb
			.delete({
				tableName: "sessions",
				where: {
					conditions: "id = ?",
					params: [sessionId],
				},
			})
			.execute();

		return true;
	}

	/**
	 * Auth operation: how long the caller must wait, in milliseconds, before
	 * any of these keys will accept another attempt. 0 means go ahead.
	 *
	 * Checked before doing the work, so a locked-out attacker doesn't even
	 * get a password verification (~17ms of CPU) out of each request.
	 */
	async throttleRetryAfter(keys: string[]): Promise<number> {
		if (!this.#isAuthDO) throw new Error("Not an auth DO");
		if (keys.length === 0) return 0;

		const now = Date.now();
		let longest = 0;
		for (const key of keys) {
			const row = this.#qb
				.select("auth_throttle")
				.fields(["locked_until"])
				.where("bucket = ?", key)
				.one().results;
			const lockedUntil = Number(row?.locked_until ?? 0);
			if (lockedUntil > now) longest = Math.max(longest, lockedUntil - now);
		}
		return longest;
	}

	/**
	 * Auth operation: count one attempt against each rule, locking any key
	 * that crosses its limit.
	 *
	 * The window is a fixed one that restarts once it lapses, not a sliding
	 * one. That is deliberately the cheaper approximation: a sliding window
	 * needs a row per attempt, and the worst case here -- an attacker landing
	 * attempts either side of a window boundary -- buys them one extra batch,
	 * not an unbounded rate.
	 */
	async throttleRecord(rules: ThrottleRule[]): Promise<void> {
		if (!this.#isAuthDO) throw new Error("Not an auth DO");

		const now = Date.now();
		for (const rule of rules) {
			const row = this.#qb
				.select("auth_throttle")
				.fields(["failures", "window_started_at", "locked_until"])
				.where("bucket = ?", rule.key)
				.one().results;

			const windowLapsed =
				!row || now - Number(row.window_started_at) >= rule.windowMs;
			const failures = windowLapsed ? 1 : Number(row.failures) + 1;
			const windowStartedAt = windowLapsed
				? now
				: Number(row.window_started_at);
			const lockedUntil =
				failures >= rule.limit
					? now + rule.lockMs
					: (row?.locked_until ?? null);

			this.ctx.storage.sql.exec(
				`INSERT INTO auth_throttle (bucket, failures, window_started_at, locked_until)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT(bucket) DO UPDATE SET
                     failures = excluded.failures,
                     window_started_at = excluded.window_started_at,
                     locked_until = excluded.locked_until`,
				rule.key,
				failures,
				windowStartedAt,
				lockedUntil,
			);
		}

		// Buckets are created per address and per IP, so without this the table
		// would grow for the lifetime of the mailbox. Anything whose window and
		// lock have both lapsed carries no information.
		this.ctx.storage.sql.exec(
			`DELETE FROM auth_throttle
             WHERE window_started_at < ? AND (locked_until IS NULL OR locked_until < ?)`,
			now - 24 * 60 * 60 * 1000,
			now,
		);
	}

	/** Auth operation: forget the failures counted against these keys. */
	async throttleReset(keys: string[]): Promise<void> {
		if (!this.#isAuthDO) throw new Error("Not an auth DO");

		for (const key of keys) {
			this.#qb
				.delete({
					tableName: "auth_throttle",
					where: { conditions: "bucket = ?", params: [key] },
				})
				.execute();
		}
	}

	// Auth operation: get all users (admin only)
	async getUsers(): Promise<User[]> {
		if (!this.#isAuthDO) throw new Error("Not an auth DO");

		const result = this.#qb
			.select("users")
			.fields(["id", "email", "is_admin", "created_at", "updated_at"])
			.execute();

		return (
			result.results?.map((user) => ({
				id: String(user.id),
				email: String(user.email),
				isAdmin: user.is_admin === 1,
				createdAt: Number(user.created_at),
				updatedAt: Number(user.updated_at),
			})) ?? []
		);
	}

	// Auth operation: get user by email
	async getUserByEmail(email: string): Promise<User | null> {
		if (!this.#isAuthDO) throw new Error("Not an auth DO");

		const result = this.#qb
			.select("users")
			.fields(["id", "email", "is_admin", "created_at", "updated_at"])
			.where("email = ?", email)
			.execute();

		if (!result.results || result.results.length === 0) {
			return null;
		}

		const user = result.results[0];
		return {
			id: String(user.id),
			email: String(user.email),
			isAdmin: user.is_admin === 1,
			createdAt: Number(user.created_at),
			updatedAt: Number(user.updated_at),
		};
	}

	// Auth operation: update user password
	async updateUserPassword(userId: string, newPassword: string): Promise<void> {
		if (!this.#isAuthDO) throw new Error("Not an auth DO");

		const hashedPassword = await hashPassword(newPassword);

		this.#qb
			.update({
				tableName: "users",
				data: {
					password_hash: hashedPassword,
					updated_at: Date.now(),
				},
				where: {
					conditions: "id = ?",
					params: [userId],
				},
			})
			.execute();
	}

	/**
	 * Auth operation: change a password, having proved the current one.
	 *
	 * Every other session belonging to the user is dropped. If the reason for
	 * changing the password is that somebody else knows it, leaving the
	 * session they are already holding alive would defeat the change.
	 */
	async changePassword(
		userId: string,
		currentPassword: string,
		newPassword: string,
		keepSessionId: string,
	): Promise<boolean> {
		if (!this.#isAuthDO) throw new Error("Not an auth DO");

		const row = this.#qb
			.select("users")
			.fields(["password_hash"])
			.where("id = ?", userId)
			.one().results;
		if (!row) return false;

		const { valid } = await verifyPassword(
			currentPassword,
			String(row.password_hash),
		);
		if (!valid) return false;

		this.#qb
			.update({
				tableName: "users",
				data: {
					password_hash: await hashPassword(newPassword),
					updated_at: Date.now(),
				},
				where: { conditions: "id = ?", params: [userId] },
			})
			.execute();

		this.ctx.storage.sql.exec(
			"DELETE FROM sessions WHERE user_id = ? AND id != ?",
			userId,
			keepSessionId,
		);
		return true;
	}

	/** Auth operation: check a user's password without issuing a session. */
	async verifyUserPassword(userId: string, password: string): Promise<boolean> {
		if (!this.#isAuthDO) throw new Error("Not an auth DO");

		const row = this.#qb
			.select("users")
			.fields(["password_hash"])
			.where("id = ?", userId)
			.one().results;
		if (!row) return false;
		return (await verifyPassword(password, String(row.password_hash))).valid;
	}

	/**
	 * Auth operation: move an account to a different address.
	 *
	 * Returns false when the address already belongs to another account --
	 * `email` is UNIQUE, and the caller needs to say so rather than fail.
	 */
	async updateUserEmail(userId: string, newEmail: string): Promise<boolean> {
		if (!this.#isAuthDO) throw new Error("Not an auth DO");

		try {
			this.ctx.storage.sql.exec(
				"UPDATE users SET email = ?, updated_at = ? WHERE id = ?",
				newEmail,
				Date.now(),
				userId,
			);
		} catch (e) {
			if (String(e).includes("UNIQUE")) return false;
			throw e;
		}
		return true;
	}

	/**
	 * Auth operation: grant or withdraw administrator rights.
	 *
	 * Refuses to remove the last administrator. Without that check a single
	 * mis-click leaves nobody able to administer the deployment, and there is
	 * no way back in: rights can only be granted by an administrator.
	 */
	async setUserAdmin(
		userId: string,
		isAdmin: boolean,
	): Promise<"ok" | "not-found" | "last-admin"> {
		if (!this.#isAuthDO) throw new Error("Not an auth DO");

		const user = this.#qb
			.select("users")
			.fields(["is_admin"])
			.where("id = ?", userId)
			.one().results;
		if (!user) return "not-found";

		if (!isAdmin && user.is_admin === 1) {
			const admins = this.ctx.storage.sql
				.exec("SELECT COUNT(*) AS count FROM users WHERE is_admin = 1")
				.toArray();
			if (Number(admins[0]?.count ?? 0) <= 1) return "last-admin";
		}

		this.#qb
			.update({
				tableName: "users",
				data: { is_admin: isAdmin ? 1 : 0, updated_at: Date.now() },
				where: { conditions: "id = ?", params: [userId] },
			})
			.execute();
		return "ok";
	}

	/** The account holding the root role, or null when there is none yet. */
	async getRootUserId(): Promise<string | null> {
		if (!this.#isAuthDO) throw new Error("Not an auth DO");

		const row = this.ctx.storage.sql
			.exec("SELECT root_user_id FROM app_roles WHERE id = 1")
			.toArray()[0];
		const value = row?.root_user_id;
		return value === null || value === undefined ? null : String(value);
	}

	/**
	 * Names the first root, and only the first.
	 *
	 * Called from one place: the registration of the very first account. It
	 * is not reachable over HTTP, and that is the point -- an endpoint that
	 * named root, however well guarded, would be "somebody may take the tier
	 * above them" on every deployment of this that exists.
	 *
	 * The guard is still here because the caller is a route: a second
	 * registration racing the first must not be able to replace the root
	 * account.
	 */
	async claimRoot(userId: string): Promise<"ok" | "not-found" | "taken"> {
		if (!this.#isAuthDO) throw new Error("Not an auth DO");

		if (await this.getRootUserId()) return "taken";

		const user = this.#qb
			.select<{ id: string }>("users")
			.fields(["id"])
			.where("id = ?", userId)
			.one().results;
		if (!user) return "not-found";

		this.ctx.storage.sql.exec(
			"UPDATE app_roles SET root_user_id = ? WHERE id = 1",
			userId,
		);
		return "ok";
	}

	/**
	 * Hands the role to another account. Called by root and nobody else.
	 *
	 * This is the handover path and the recovery path at once. Without it the
	 * only way out of a lost root account would be editing the storage from
	 * the Cloudflare side, which is a thing to fall back on, not a thing to
	 * plan around.
	 */
	async transferRoot(userId: string): Promise<"ok" | "not-found"> {
		if (!this.#isAuthDO) throw new Error("Not an auth DO");

		const user = this.#qb
			.select<{ id: string }>("users")
			.fields(["id"])
			.where("id = ?", userId)
			.one().results;
		if (!user) return "not-found";

		this.ctx.storage.sql.exec(
			"UPDATE app_roles SET root_user_id = ? WHERE id = 1",
			userId,
		);
		return "ok";
	}

	/**
	 * Grants access, or changes the role if there already is some.
	 *
	 * A plain insert used to throw on the primary key, which made "assign this
	 * mailbox" a request that succeeded the first time and returned a 500 the
	 * second -- and there is no way for a caller to know which it is without
	 * reading the grants first. Assigning a mailbox to somebody who already
	 * has it is not an error; it is the same sentence said twice.
	 */
	async grantMailboxAccess(
		userId: string,
		mailboxId: string,
		role: string,
	): Promise<void> {
		if (!this.#isAuthDO) throw new Error("Not an auth DO");

		this.ctx.storage.sql.exec(
			"INSERT OR REPLACE INTO user_mailboxes (user_id, mailbox_id, role) VALUES (?, ?, ?)",
			userId,
			mailboxId,
			role,
		);
	}

	/**
	 * Grants access only if the user does not already have some on that
	 * mailbox, leaving any existing role alone.
	 *
	 * The backfill that gives every already-existing mailbox an explicit owner
	 * has to be safe to run twice -- it runs from whichever request happens to
	 * arrive first after a deploy, and two of those can be in flight at once.
	 * A plain insert would fail on the primary key the second time, and
	 * INSERT OR REPLACE would quietly demote an owner to whatever the backfill
	 * happens to pass.
	 */
	async grantMailboxAccessIfAbsent(
		userId: string,
		mailboxId: string,
		role: string,
	): Promise<void> {
		if (!this.#isAuthDO) throw new Error("Not an auth DO");

		this.ctx.storage.sql.exec(
			"INSERT OR IGNORE INTO user_mailboxes (user_id, mailbox_id, role) VALUES (?, ?, ?)",
			userId,
			mailboxId,
			role,
		);
	}

	/**
	 * Removes an account: its mailbox grants and its sessions go with it.
	 *
	 * The grants have to go or a later account reusing the same id would
	 * inherit them, and the sessions have to go or a deleted account keeps
	 * working until its token expires -- thirty days of an account somebody
	 * deleted on purpose.
	 *
	 * The mailboxes themselves are untouched. Deleting a person must not
	 * delete the mail: the addresses outlive whoever was looking after them,
	 * and root reassigns them afterwards.
	 */
	async deleteUser(userId: string): Promise<"ok" | "not-found" | "last-admin"> {
		if (!this.#isAuthDO) throw new Error("Not an auth DO");

		const user = this.#qb
			.select<{ is_admin: number }>("users")
			.fields(["is_admin"])
			.where("id = ?", userId)
			.one().results;
		if (!user) return "not-found";

		// The same guard as demotion, for the same reason: rights here can
		// only be granted by an administrator, so removing the last one leaves
		// nobody able to grant them back.
		if (user.is_admin === 1) {
			const admins = this.ctx.storage.sql
				.exec("SELECT COUNT(*) AS count FROM users WHERE is_admin = 1")
				.toArray();
			if (Number(admins[0]?.count ?? 0) <= 1) return "last-admin";
		}

		this.ctx.storage.sql.exec(
			"DELETE FROM user_mailboxes WHERE user_id = ?",
			userId,
		);
		this.ctx.storage.sql.exec("DELETE FROM sessions WHERE user_id = ?", userId);
		this.ctx.storage.sql.exec("DELETE FROM users WHERE id = ?", userId);
		return "ok";
	}

	/**
	 * Sets an account's password without asking for the old one.
	 *
	 * Only root reaches this. It is what makes an in-system address usable as
	 * a login: a person whose recovery mail arrives in a mailbox they cannot
	 * open until they log in is otherwise locked out for good.
	 *
	 * Every session of that account is dropped. A password reset that leaves
	 * the old sessions alive resets nothing -- whoever prompted the reset
	 * keeps the access they already had.
	 */
	async setUserPassword(
		userId: string,
		password: string,
	): Promise<"ok" | "not-found"> {
		if (!this.#isAuthDO) throw new Error("Not an auth DO");

		const user = this.#qb
			.select<{ id: string }>("users")
			.fields(["id"])
			.where("id = ?", userId)
			.one().results;
		if (!user) return "not-found";

		this.ctx.storage.sql.exec(
			"UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?",
			await hashPassword(password),
			Date.now(),
			userId,
		);
		this.ctx.storage.sql.exec("DELETE FROM sessions WHERE user_id = ?", userId);
		return "ok";
	}

	// Auth operation: revoke mailbox access
	async revokeMailboxAccess(userId: string, mailboxId: string): Promise<void> {
		if (!this.#isAuthDO) throw new Error("Not an auth DO");

		this.#qb
			.delete({
				tableName: "user_mailboxes",
				where: {
					conditions: "user_id = ? AND mailbox_id = ?",
					params: [userId, mailboxId],
				},
			})
			.execute();
	}

	// Auth operation: get user mailboxes
	async getUserMailboxes(
		userId: string,
	): Promise<Array<{ mailboxId: string; role: string }>> {
		if (!this.#isAuthDO) throw new Error("Not an auth DO");

		const result = this.#qb
			.select("user_mailboxes")
			.fields(["mailbox_id", "role"])
			.where("user_id = ?", userId)
			.execute();

		return (
			result.results?.map((row) => ({
				mailboxId: String(row.mailbox_id),
				role: String(row.role),
			})) ?? []
		);
	}

	// Push operation: get ids of every user who should be notified for a
	// mailbox -- admins (implicit access to everything) plus anyone granted
	// explicit access via user_mailboxes.
	async getUserIdsForMailbox(mailboxId: string): Promise<string[]> {
		if (!this.#isAuthDO) throw new Error("Not an auth DO");

		const admins = this.#qb
			.select("users")
			.fields(["id"])
			.where("is_admin = 1")
			.execute();

		const granted = this.#qb
			.select("user_mailboxes")
			.fields(["user_id"])
			.where("mailbox_id = ?", mailboxId)
			.execute();

		const ids = new Set<string>();
		for (const row of admins.results ?? []) ids.add(String(row.id));
		for (const row of granted.results ?? []) ids.add(String(row.user_id));
		return Array.from(ids);
	}

	// Push operation: save a subscription for a user (upsert by endpoint)
	async savePushSubscription(
		userId: string,
		endpoint: string,
		keys: { p256dh: string; auth: string },
	): Promise<void> {
		if (!this.#isAuthDO) throw new Error("Not an auth DO");

		this.#qb
			.delete({
				tableName: "push_subscriptions",
				where: { conditions: "endpoint = ?", params: [endpoint] },
			})
			.execute();

		this.#qb
			.insert({
				tableName: "push_subscriptions",
				data: {
					id: crypto.randomUUID(),
					user_id: userId,
					endpoint,
					p256dh: keys.p256dh,
					auth: keys.auth,
					created_at: Date.now(),
				},
			})
			.execute();
	}

	// Push operation: remove a subscription by endpoint
	async removePushSubscription(endpoint: string): Promise<void> {
		if (!this.#isAuthDO) throw new Error("Not an auth DO");

		this.#qb
			.delete({
				tableName: "push_subscriptions",
				where: { conditions: "endpoint = ?", params: [endpoint] },
			})
			.execute();
	}

	// Push operation: get subscriptions for a set of users
	async getPushSubscriptionsForUsers(
		userIds: string[],
	): Promise<Array<{ endpoint: string; p256dh: string; auth: string }>> {
		if (!this.#isAuthDO) throw new Error("Not an auth DO");
		if (userIds.length === 0) return [];

		const placeholders = userIds.map(() => "?").join(", ");
		const result = this.#qb
			.select("push_subscriptions")
			.fields(["endpoint", "p256dh", "auth"])
			.where(`user_id IN (${placeholders})`, userIds)
			.execute();

		return (
			result.results?.map((row) => ({
				endpoint: String(row.endpoint),
				p256dh: String(row.p256dh),
				auth: String(row.auth),
			})) ?? []
		);
	}

	/**
	 * A folder can be given either way round -- "inbox" is the row's id and
	 * "Inbox" its display name -- so it has to be looked up rather than compared
	 * to folder_id directly. Returns undefined when no such folder exists.
	 *
	 * This runs as its own query instead of being handed to where() as a
	 * subquery: workers-qb only accepts an async SelectBuilder as a parameter,
	 * and a Durable Object's builder is the synchronous one, so the subquery
	 * form stopped type-checking at workers-qb 1.15. Splitting it costs nothing
	 * here -- it is a lookup on a five-row table in the same SQLite instance.
	 */
	#resolveFolderId(folder: string): string | undefined {
		const resolved = this.#qb
			.select<{ id: string }>("folders")
			.fields(["id"])
			.where("name = ? OR id = ?", [folder, folder])
			.limit(1)
			.execute();
		return resolved.results?.[0]?.id;
	}

	async getEmails(options: GetEmailsOptions = {}) {
		const {
			folder,
			page = 1,
			limit = 25,
			sortColumn: rawSortColumn = "date",
			sortDirection = "DESC",
		} = options;

		const sortColumn: SortColumn = ALLOWED_SORT_COLUMNS.includes(
			rawSortColumn as SortColumn,
		)
			? rawSortColumn
			: "date";

		let query = this.#qb
			.select<EmailData>("emails")
			.fields([
				"id",
				"subject",
				"sender",
				"recipient",
				"date",
				"read",
				"starred",
				"in_reply_to",
				"email_references",
				"thread_id",
			]);

		const folderId = folder ? this.#resolveFolderId(folder) : undefined;
		if (folder && !folderId) return [];
		if (folderId) query = query.where("folder_id = ?", folderId);

		const offset = (page - 1) * limit;
		query = query
			.orderBy(`${sortColumn} ${sortDirection}`)
			.limit(limit)
			.offset(offset);

		const result = query.execute();

		return (
			result.results?.map((email) => ({
				...email,
				read: !!email.read,
				starred: !!email.starred,
			})) ?? []
		);
	}

	async getEmail(id: string) {
		const email = this.#qb
			.select("emails")
			.fields(["*"])
			.where("id = ?", id)
			.one();

		if (!email.results) {
			return null;
		}

		const attachments = this.#qb
			.select("attachments")
			.fields(["*"])
			.where("email_id = ?", id)
			.execute();

		return {
			...email.results,
			read: !!email.results.read,
			starred: !!email.results.starred,
			attachments: attachments.results || [],
		};
	}

	async updateEmail(
		id: string,
		{ read, starred }: { read?: boolean; starred?: boolean },
	) {
		const data: { read?: number; starred?: number } = {};
		if (read !== undefined) {
			data.read = read ? 1 : 0;
		}
		if (starred !== undefined) {
			data.starred = starred ? 1 : 0;
		}

		if (Object.keys(data).length === 0) {
			return this.getEmail(id);
		}

		this.#qb
			.update({
				tableName: "emails",
				data,
				where: {
					conditions: "id = ?",
					params: [id],
				},
			})
			.execute();

		return this.getEmail(id);
	}

	async updateDraftContent(
		id: string,
		{
			subject,
			sender,
			recipient,
			cc,
			bcc,
			body,
		}: {
			subject: string;
			sender: string;
			recipient: string;
			cc: string | null;
			bcc: string | null;
			body: string;
		},
	) {
		this.#qb
			.update({
				tableName: "emails",
				data: {
					subject,
					sender,
					recipient,
					cc,
					bcc,
					body,
					date: new Date().toISOString(),
				},
				where: {
					conditions: "id = ? AND folder_id = 'draft'",
					params: [id],
				},
			})
			.execute();

		return this.getEmail(id);
	}

	async deleteEmail(id: string) {
		const attachments = this.#qb
			.select("attachments")
			.fields(["id", "filename"])
			.where("email_id = ?", id)
			.execute();

		this.#qb
			.delete({
				tableName: "emails",
				where: {
					conditions: "id = ?",
					params: [id],
				},
			})
			.execute();

		return attachments.results || [];
	}

	/**
	 * Every email id held by this mailbox. Purging a mailbox has to collect
	 * these *before* the storage is wiped: the R2 keys for raw messages and
	 * attachments are named after the email id alone, with no mailbox in the
	 * path, so once the database is gone there is nothing left to look them
	 * up by and they would sit in the bucket forever.
	 */
	async listAllEmailIds(): Promise<string[]> {
		const result = this.#qb
			.select<{ id: string }>("emails")
			.fields(["id"])
			.execute();
		return result.results?.map((row) => String(row.id)) ?? [];
	}

	/**
	 * Ids only, oldest first -- the export streams one message at a time and
	 * fetches each body as it goes, so that a mailbox of any size costs one
	 * message worth of memory rather than all of them at once.
	 */
	/**
	 * The spam folder's messages with their stored dates, for the scheduled
	 * purge to decide which are past their retention.
	 *
	 * The decision is not made in SQL. Most of these dates are ISO timestamps
	 * in UTC and would compare correctly as text, but an imported message
	 * carries whatever its own Date header said -- an offset, or a format that
	 * sorts nowhere near where it belongs -- and comparing those as text would
	 * pick the wrong messages to delete. See expiredSpamIds.
	 */
	async listSpamEmailDates(): Promise<{ id: string; date: string | null }[]> {
		const rows = this.ctx.storage.sql
			.exec("SELECT id, date FROM emails WHERE folder_id = 'spam'")
			.toArray();
		return rows.map((row) => ({
			id: String(row.id),
			date:
				row.date === null || row.date === undefined ? null : String(row.date),
		}));
	}

	async listEmailIdsByDate(): Promise<string[]> {
		const rows = this.ctx.storage.sql
			.exec("SELECT id FROM emails ORDER BY date ASC")
			.toArray();
		return rows.map((row) => String(row.id));
	}

	/**
	 * Wipes this mailbox's Durable Object -- emails, folders, contacts,
	 * attachment records. deleteAll() drops the SQLite tables themselves, not
	 * just their rows.
	 *
	 * The empty schema is then recreated. Migrations normally run in the
	 * constructor, but this instance is already live and would keep serving
	 * "no such table" to anything that touched the mailbox before it happened
	 * to be evicted. Re-applying leaves it exactly as a cold start would.
	 */
	async destroyMailbox(): Promise<void> {
		if (this.#isAuthDO) throw new Error("Refusing to destroy the auth DO");
		await this.ctx.storage.deleteAll();
		this.#qb.migrations({ migrations: mailboxMigrations }).apply();
	}

	// Auth operation: drop every user's access to a mailbox that is going away.
	async revokeAllMailboxAccess(mailboxId: string): Promise<void> {
		if (!this.#isAuthDO) throw new Error("Not an auth DO");

		this.#qb
			.delete({
				tableName: "user_mailboxes",
				where: {
					conditions: "mailbox_id = ?",
					params: [mailboxId],
				},
			})
			.execute();
	}

	async getAttachment(id: string) {
		const result = this.#qb
			.select<AttachmentData>("attachments")
			.fields(["*"])
			.where("id = ?", id)
			.one();
		return result.results;
	}

	/**
	 * Remembers how the last second-stage spam check went, so a filter that
	 * has quietly stopped working can be seen on the settings screen.
	 *
	 * Success and failure are kept side by side rather than as one "last
	 * outcome": the useful question is not what happened most recently but
	 * whether it is still working, and "last succeeded three weeks ago" is the
	 * answer to that. Written on every checked message, which is why this is
	 * in the Durable Object -- its writes are serialised, an R2
	 * read-modify-write would not be.
	 */
	async recordSpamCheck(
		at: string,
		failure?: string,
		detail?: string,
	): Promise<void> {
		this.#qb
			.update({
				tableName: "spam_check_health",
				data: failure
					? {
							last_failure_at: at,
							last_failure_reason: failure,
							// Written every time, including when there is nothing to
							// write: otherwise the detail of an older, different
							// failure would still be on screen beside the new reason.
							last_failure_detail: detail ?? null,
						}
					: { last_success_at: at },
				where: { conditions: "id = 1" },
			})
			.execute();
	}

	async getSpamCheckHealth(): Promise<{
		lastSuccessAt: string | null;
		lastFailureAt: string | null;
		lastFailureReason: string | null;
		lastFailureDetail: string | null;
	}> {
		const row = this.#qb
			.select<{
				last_success_at: string | null;
				last_failure_at: string | null;
				last_failure_reason: string | null;
				last_failure_detail: string | null;
			}>("spam_check_health")
			.fields([
				"last_success_at",
				"last_failure_at",
				"last_failure_reason",
				"last_failure_detail",
			])
			.where("id = ?", 1)
			.one().results;

		return {
			lastSuccessAt: row?.last_success_at ?? null,
			lastFailureAt: row?.last_failure_at ?? null,
			lastFailureReason: row?.last_failure_reason ?? null,
			lastFailureDetail: row?.last_failure_detail ?? null,
		};
	}

	async getFolders() {
		const query = this.#qb.select("folders").fields(["id", "name"]);

		const result = query.execute();
		return result.results || [];
	}

	async createFolder(id: string, name: string) {
		try {
			const result = this.#qb
				.insert({
					tableName: "folders",
					data: { id, name },
					returning: ["id", "name"],
				})
				.execute();
			const newFolder = result.results;
			return { ...newFolder, unreadCount: 0 };
		} catch (e: any) {
			if (e.message.includes("UNIQUE constraint failed")) {
				return null;
			}
			throw e;
		}
	}

	async updateFolder(id: string, name: string) {
		this.#qb
			.update({
				tableName: "folders",
				data: { name },
				where: {
					conditions: "id = ?",
					params: [id],
				},
			})
			.execute();
		const query = this.#qb
			.select("folders")
			.fields(["id", "name"])
			.where("id = ?", id);
		const result = query.one();
		return result.results;
	}

	async deleteFolder(id: string) {
		const folder = this.#qb
			.select<{ is_deletable: number }>("folders")
			.fields(["is_deletable"])
			.where("id = ?", id)
			.one();

		if (!folder.results || folder.results.is_deletable === 0) {
			return false;
		}

		this.#qb
			.delete({
				tableName: "folders",
				where: {
					conditions: "id = ?",
					params: [id],
				},
			})
			.execute();

		return true;
	}

	async getContacts() {
		const query = this.#qb.select("contacts").fields(["id", "name", "email"]);
		const result = query.execute();
		return result.results || [];
	}

	async createContact(contact: { name?: string; email: string }) {
		const result = this.#qb
			.insert({
				tableName: "contacts",
				data: contact,
				returning: ["id", "name", "email"],
			})
			.execute();
		return result.results;
	}

	async updateContact(id: number, contact: { name?: string; email?: string }) {
		this.#qb
			.update({
				tableName: "contacts",
				data: contact,
				where: {
					conditions: "id = ?",
					params: [id],
				},
			})
			.execute();
		const query = this.#qb
			.select("contacts")
			.fields(["id", "name", "email"])
			.where("id = ?", id);
		const result = query.one();
		return result.results;
	}

	async deleteContact(id: number) {
		this.#qb
			.delete({
				tableName: "contacts",
				where: {
					conditions: "id = ?",
					params: [id],
				},
			})
			.execute();
		return true;
	}

	async moveEmail(id: string, folderId: string) {
		const folder = this.#qb
			.select("folders")
			.fields(["id"])
			.where("id = ?", folderId)
			.one();

		if (!folder.results) {
			return false;
		}

		this.#qb
			.update({
				tableName: "emails",
				data: { folder_id: folderId },
				where: {
					conditions: "id = ?",
					params: [id],
				},
			})
			.execute();

		return true;
	}

	async searchEmails(options: {
		query: string;
		folder?: string;
		from?: string;
		to?: string;
		date_start?: string;
		date_end?: string;
	}) {
		const { query, folder, from, to, date_start, date_end } = options;
		let qb = this.#qb
			.select<EmailData>("emails")
			.fields([
				"id",
				"subject",
				"sender",
				"recipient",
				"date",
				"read",
				"starred",
				"in_reply_to",
				"email_references",
				"thread_id",
			]);

		const folderId = folder ? this.#resolveFolderId(folder) : undefined;
		// An unknown folder matches nothing. The subquery form this replaced
		// reached the same place by comparing folder_id against NULL.
		if (folder && !folderId) return [];
		if (folderId) qb = qb.where("folder_id = ?", folderId);

		if (from) {
			qb = qb.where("sender LIKE ?", `%${from}%`);
		}

		if (to) {
			qb = qb.where("recipient LIKE ?", `%${to}%`);
		}

		if (date_start) {
			qb = qb.where("date >= ?", date_start);
		}

		if (date_end) {
			qb = qb.where("date <= ?", date_end);
		}

		qb = qb.where("(subject LIKE ? OR body LIKE ?)", [
			`%${query}%`,
			`%${query}%`,
		]);

		const result = qb.execute();

		return (
			result.results?.map((email) => ({
				...email,
				read: !!email.read,
				starred: !!email.starred,
			})) ?? []
		);
	}

	async createEmail(
		folder: string,
		email: EmailData,
		attachments: AttachmentData[],
	) {
		this.#qb
			.insert({
				tableName: "emails",
				data: { ...email, folder_id: folder },
			})
			.execute();

		if (attachments.length > 0) {
			this.#qb
				.insert({
					tableName: "attachments",
					data: attachments as any,
				})
				.execute();
		}
	}
}
