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
					sql
						.exec("SELECT person_id FROM users WHERE id = ?", id)
						.toArray()[0]?.person_id,
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
