import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sessionToken, testAuthBeforeAll } from "./utils";

/**
 * The auth object's two lookups that read whole tables.
 *
 * Sign-in finds an account by its address without regard to case, and the
 * UNIQUE index on `users.email` is case-sensitive, so every sign-in,
 * registration and address change scanned every login. And signing out
 * deletes a session's push subscription by `session_id`, which had no index.
 * SQLite's own plan says which it does.
 *
 * Of the statement the object actually runs, caught on its way to SQLite:
 * explaining a copy typed out here went on passing whatever the code sent.
 */

type Ran = { sql: string; params: unknown[] };

const authDO = () => env.MAILBOX.get(env.MAILBOX.idFromName("AUTH"));

/** Every statement `act` sends to SQLite; see listing-indexes.test.ts. */
async function statementsOf(
	act: (instance: unknown) => Promise<unknown>,
): Promise<Ran[]> {
	return runInDurableObject(authDO(), async (instance, state) => {
		const sql = state.storage.sql;
		const exec = sql.exec;
		const ran: Ran[] = [];
		sql.exec = ((query: string, ...params: unknown[]) => {
			ran.push({ sql: query, params });
			return exec.call(sql, query, ...(params as SqlStorageValue[]));
		}) as typeof sql.exec;
		try {
			await act(instance);
		} finally {
			sql.exec = exec;
		}
		return ran;
	});
}

/** The one statement matching `shape`; more or fewer is a changed query. */
function theOne(ran: Ran[], shape: RegExp): Ran {
	const matching = ran.filter((r) => shape.test(r.sql));
	expect(
		matching.map((r) => r.sql),
		`statements matching ${shape}`,
	).toHaveLength(1);
	return matching[0];
}

async function plan({ sql, params }: Ran): Promise<string> {
	return runInDurableObject(authDO(), async (_i, state) =>
		state.storage.sql
			.exec(`EXPLAIN QUERY PLAN ${sql}`, ...(params as SqlStorageValue[]))
			.toArray()
			.map((row) => String(row.detail))
			.join("\n"),
	);
}

type Auth = {
	getUserByEmail: (email: string) => Promise<unknown>;
	logout: (sessionId: string) => Promise<boolean>;
};

describe("the auth object's storage", () => {
	// Seeds through the object, which applies its migrations first.
	beforeEach(testAuthBeforeAll);

	it("finds an account by address, without case, without reading every login", async () => {
		const ran = await statementsOf((instance) =>
			(instance as Auth).getUserByEmail("A@Example.com"),
		);
		const detail = await plan(theOne(ran, /\bFROM users WHERE email\b/));
		expect(detail).toContain("idx_users_email_nocase");
		expect(detail).not.toMatch(/^SCAN users\b/m);
	});

	it("finds a session's push subscriptions without reading all of them", async () => {
		const ran = await statementsOf((instance) =>
			(instance as Auth).logout(sessionToken),
		);
		const detail = await plan(
			theOne(ran, /\bDELETE FROM push_subscriptions WHERE session_id\b/),
		);
		expect(detail).toContain("idx_push_subscriptions_session_id");
		expect(detail).not.toMatch(/^SCAN push_subscriptions\b/m);
	});
});
