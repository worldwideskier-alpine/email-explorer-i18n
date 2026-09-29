import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { testAuthBeforeAll } from "./utils";

/**
 * The auth object's two lookups that read whole tables.
 *
 * Sign-in finds an account by its address without regard to case, and the
 * UNIQUE index on `users.email` is case-sensitive, so every sign-in,
 * registration and address change scanned every login. And signing out
 * deletes a session's push subscription by `session_id`, which had no index.
 * SQLite's own plan says which it does.
 */

async function plan(sql: string, ...params: unknown[]): Promise<string> {
	const stub = env.MAILBOX.get(env.MAILBOX.idFromName("AUTH"));
	return runInDurableObject(stub, async (_i, state) =>
		state.storage.sql
			.exec(`EXPLAIN QUERY PLAN ${sql}`, ...params)
			.toArray()
			.map((row) => String(row.detail))
			.join("\n"),
	);
}

describe("the auth object's storage", () => {
	// Seeds through the object, which applies its migrations first.
	beforeEach(testAuthBeforeAll);

	it("finds an account by address, without case, without reading every login", async () => {
		const detail = await plan(
			"SELECT * FROM users WHERE email = ? COLLATE NOCASE ORDER BY (email = ?) DESC LIMIT 1",
			"a@example.com",
			"a@example.com",
		);
		expect(detail).toContain("idx_users_email_nocase");
		expect(detail).not.toMatch(/^SCAN users\b/m);
	});

	it("finds a session's push subscriptions without reading all of them", async () => {
		const detail = await plan(
			"DELETE FROM push_subscriptions WHERE session_id = ?",
			"s",
		);
		expect(detail).toContain("idx_push_subscriptions_session_id");
		expect(detail).not.toMatch(/^SCAN push_subscriptions\b/m);
	});
});
