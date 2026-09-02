import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { authMigrations } from "../../src/durableObject/migrations";
import { LEGACY_ADMIN_PERSON_ID } from "../../src/people";

/**
 * The line that decides whether a deployment survives this change.
 *
 * Everything else here is about deployments that start after it. This is
 * about the one that already exists: two logins, both carrying the admin
 * flag, both one person, both seeing the business's mail because the flag
 * showed everybody everything. If the migration does not put them in one
 * person, the second login opens onto an empty screen the moment the flag
 * stops meaning anything -- and the mail is still arriving in a mailbox
 * nobody can reach.
 *
 * No other test can reach it. A test Durable Object is created empty, so the
 * migration runs against a table with no rows in it and its two UPDATEs
 * match nothing: removing them entirely leaves the whole suite green. So the
 * statements are taken from the shipped migration -- not a copy of them --
 * and run against rows in the state they would have been in.
 */

const peopleMigration = authMigrations.find((m) => m.name === "5_people");
const ownMigration = authMigrations.find((m) => m.name === "6_people_own");

/** Statements from the shipped migration, in the order it runs them. */
function statementsOf(sql: string): string[] {
	return sql
		.split(";")
		.map((statement) => statement.trim())
		.filter(Boolean);
}

/** The UPDATEs from the shipped migration, in the order it runs them. */
const backfillStatements = (peopleMigration?.sql ?? "")
	.split(";")
	.map((statement) => statement.trim())
	.filter((statement) => statement.toUpperCase().startsWith("UPDATE"));

describe("the migration that gives each login a person", () => {
	it("ships two backfill statements", () => {
		expect(peopleMigration).toBeDefined();
		expect(backfillStatements).toHaveLength(2);
	});

	it("puts every administrator into one person and everyone else on their own", async () => {
		const stub = env.MAILBOX.get(env.MAILBOX.idFromName("AUTH"));

		await runInDurableObject(stub, async (_instance, state) => {
			const sql = state.storage.sql;
			const now = Date.now();

			// The table as it stood before the column existed: person unset.
			// Two administrators -- one person with a spare login -- and one
			// account that never was one.
			for (const [id, email, isAdmin] of [
				["legacy-first", "a@example.com", 1],
				["legacy-spare", "a-spare@example.com", 1],
				["legacy-other", "someone@example.com", 0],
			] as const) {
				sql.exec(
					"INSERT INTO users (id, email, password_hash, is_admin, person_id, created_at, updated_at) VALUES (?, ?, 'x', ?, NULL, ?, ?)",
					id,
					email,
					isAdmin,
					now,
					now,
				);
			}

			for (const statement of backfillStatements) sql.exec(statement);

			const personOf = (id: string) =>
				String(
					sql.exec("SELECT person_id FROM users WHERE id = ?", id).toArray()[0]
						?.person_id,
				);

			// The two logins that were administrators are now one person.
			expect(personOf("legacy-first")).toBe(LEGACY_ADMIN_PERSON_ID);
			expect(personOf("legacy-spare")).toBe(LEGACY_ADMIN_PERSON_ID);

			// And the account that was not is not swept in with them.
			expect(personOf("legacy-other")).not.toBe(LEGACY_ADMIN_PERSON_ID);
			expect(personOf("legacy-other")).toBe("person-legacy-other");

			// Nothing is left without a person: an unset one is not a group.
			const unset = sql
				.exec("SELECT COUNT(*) AS n FROM users WHERE person_id IS NULL")
				.toArray()[0];
			expect(Number(unset?.n)).toBe(0);
		});
	});
});

/**
 * The statement that carries a deployment's existing mailboxes across.
 *
 * The one that decides whether the live deployment keeps working. Ownership
 * was recorded against a login; it has to end up against that login's person,
 * or every mailbox in use disappears from every screen while the mail goes on
 * arriving in it. Two logins of one person collapse onto the same row once
 * the person is the key, which is what the INSERT OR IGNORE is for.
 *
 * As with the migration above, no other test can reach it: a test Durable
 * Object is created empty, so the copy finds nothing to copy and removing it
 * leaves the whole suite green.
 */
describe("the migration that moves ownership onto the person", () => {
	it("ships the statements it needs", () => {
		expect(ownMigration).toBeDefined();
		const sql = ownMigration?.sql ?? "";
		expect(sql).toContain("person_mailboxes");
		expect(sql).toContain("root_person_id");
	});

	it("carries each login's mailboxes to its person, merging the duplicates", async () => {
		const stub = env.MAILBOX.get(env.MAILBOX.idFromName("AUTH"));

		await runInDurableObject(stub, async (_instance, state) => {
			const sql = state.storage.sql;
			const now = Date.now();

			// The table as the migration would find it: the two logins of one
			// person, each already carrying a claim on the same two mailboxes
			// -- which is what the old backfill wrote, one row per login --
			// plus somebody else with their own.
			sql.exec(
				"CREATE TABLE IF NOT EXISTS user_mailboxes (user_id TEXT NOT NULL, mailbox_id TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (user_id, mailbox_id))",
			);
			sql.exec("DELETE FROM user_mailboxes");
			sql.exec("DELETE FROM person_mailboxes");
			for (const [id, email, person] of [
				["a-first", "a@example.com", LEGACY_ADMIN_PERSON_ID],
				["a-spare", "a-spare@example.com", LEGACY_ADMIN_PERSON_ID],
				["b-only", "b@example.com", "person-b"],
			] as const) {
				sql.exec(
					"INSERT OR REPLACE INTO users (id, email, password_hash, is_admin, person_id, created_at, updated_at) VALUES (?, ?, 'x', 1, ?, ?, ?)",
					id,
					email,
					person,
					now,
					now,
				);
			}
			for (const [user, mailbox] of [
				["a-first", "info@example.com"],
				["a-first", "uota@example.com"],
				["a-spare", "info@example.com"],
				["a-spare", "uota@example.com"],
				["b-only", "shop@example.com"],
			] as const) {
				sql.exec(
					"INSERT INTO user_mailboxes (user_id, mailbox_id, role) VALUES (?, ?, 'owner')",
					user,
					mailbox,
				);
			}

			// The shipped copy, run on its own against that state.
			const copy = statementsOf(ownMigration?.sql ?? "").find((statement) =>
				statement.startsWith("INSERT OR IGNORE INTO person_mailboxes"),
			);
			expect(copy).toBeDefined();
			sql.exec(copy as string);

			const held = (personId: string) =>
				sql
					.exec(
						"SELECT mailbox_id FROM person_mailboxes WHERE person_id = ? ORDER BY mailbox_id",
						personId,
					)
					.toArray()
					.map((row) => String(row.mailbox_id));

			// Both of A's mailboxes, once each rather than twice.
			expect(held(LEGACY_ADMIN_PERSON_ID)).toEqual([
				"info@example.com",
				"uota@example.com",
			]);
			// And nobody has picked up anybody else's on the way.
			expect(held("person-b")).toEqual(["shop@example.com"]);
		});
	});
});

/**
 * The statement that keeps somebody being root.
 *
 * The role used to be an account id. If it is not carried over to that
 * account's person, `root_person_id` stays empty, and empty means nobody --
 * every root-only route refuses everyone and the account screen is gone. The
 * deployment would not break loudly; it would just quietly have no owner.
 *
 * Untestable through the API for the same reason as the others: a test
 * Durable Object starts with no root recorded at all, so the statement finds
 * nothing to carry and removing it leaves the suite green.
 */
describe("the migration that moves the root role onto the person", () => {
	it("carries it to the person holding that login", async () => {
		const stub = env.MAILBOX.get(env.MAILBOX.idFromName("AUTH"));

		await runInDurableObject(stub, async (_instance, state) => {
			const sql = state.storage.sql;
			const now = Date.now();

			sql.exec(
				"INSERT OR REPLACE INTO users (id, email, password_hash, is_admin, person_id, created_at, updated_at) VALUES ('the-root', 'root@example.com', 'x', 0, 'person-root', ?, ?)",
				now,
				now,
			);
			// As the old column had it: the role against one login.
			sql.exec("UPDATE app_roles SET root_person_id = NULL WHERE id = 1");
			sql.exec("UPDATE app_roles SET root_user_id = 'the-root' WHERE id = 1");

			const carry = statementsOf(ownMigration?.sql ?? "").find((statement) =>
				statement.startsWith("UPDATE app_roles"),
			);
			expect(carry).toBeDefined();
			sql.exec(carry as string);

			const row = sql
				.exec("SELECT root_person_id FROM app_roles WHERE id = 1")
				.toArray()[0];
			expect(String(row?.root_person_id)).toBe("person-root");
		});
	});

	// A deployment that never named one stays without one, rather than the
	// statement writing something that happens to match nothing.
	it("leaves a deployment with no root without one", async () => {
		const stub = env.MAILBOX.get(env.MAILBOX.idFromName("AUTH"));

		await runInDurableObject(stub, async (_instance, state) => {
			const sql = state.storage.sql;
			sql.exec(
				"UPDATE app_roles SET root_person_id = NULL, root_user_id = NULL WHERE id = 1",
			);

			const carry = statementsOf(ownMigration?.sql ?? "").find((statement) =>
				statement.startsWith("UPDATE app_roles"),
			);
			sql.exec(carry as string);

			const row = sql
				.exec("SELECT root_person_id FROM app_roles WHERE id = 1")
				.toArray()[0];
			expect(row?.root_person_id ?? null).toBeNull();
		});
	});
});
