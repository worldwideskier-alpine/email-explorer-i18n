import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createDummyMailbox, mailboxId, testAuthBeforeAll } from "./utils";

/**
 * The two questions a mailbox is asked most -- one folder's mail, newest
 * first, and one message's attachments -- each read the whole table: there
 * was no index on either. SQLite's own plan says which it does.
 *
 * Of the statement the object actually runs, caught on its way to SQLite.
 * These used to explain a copy of the SQL typed out here, which went on
 * passing whatever the code sent: a query rewritten so that it could no longer
 * use the index would have left the copy, and the test, as they were.
 */

type Ran = { sql: string; params: unknown[] };

const box = () => env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));

/**
 * Every statement `act` sends to SQLite. The object's query builder holds
 * the same `SqlStorage` the state hands out, so replacing `exec` on it for
 * the length of one call sees the builder's statements and the hand-written
 * ones alike.
 */
async function statementsOf(
	act: (instance: unknown) => Promise<unknown>,
): Promise<Ran[]> {
	const stub = box();
	// Asked once through the stub first, so the object has applied its
	// migrations before its storage is watched.
	await stub.getFolders();
	return runInDurableObject(stub, async (instance, state) => {
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
	return runInDurableObject(box(), async (_i, state) =>
		state.storage.sql
			.exec(`EXPLAIN QUERY PLAN ${sql}`, ...(params as SqlStorageValue[]))
			.toArray()
			.map((row) => String(row.detail))
			.join("\n"),
	);
}

type Mailbox = {
	getEmails: (o: { folder?: string }) => Promise<unknown[]>;
	getEmail: (id: string) => Promise<unknown>;
	createEmail: (
		folder: string,
		email: Record<string, unknown>,
		attachments: unknown[],
	) => Promise<void>;
};

describe("a mailbox's storage", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
	});

	it("finds one folder's mail, newest first, without reading the rest", async () => {
		const ran = await statementsOf((instance) =>
			(instance as Mailbox).getEmails({ folder: "inbox" }),
		);
		const detail = await plan(theOne(ran, /\bFROM emails\b.*\bORDER BY\b/s));
		expect(detail).toContain("idx_emails_folder_date");
		expect(detail).not.toMatch(/^SCAN emails\b/m);
		expect(detail).not.toContain("TEMP B-TREE");
	});

	it("finds a message's attachments without reading every one", async () => {
		await box().createEmail(
			"inbox",
			{
				id: "some-id",
				subject: "s",
				sender: "a@example.org",
				recipient: mailboxId,
				date: new Date().toISOString(),
				read: false,
				starred: false,
				body: "b",
			},
			[],
		);
		const ran = await statementsOf((instance) =>
			(instance as Mailbox).getEmail("some-id"),
		);
		const detail = await plan(theOne(ran, /\bFROM attachments\b/));
		expect(detail).toContain("idx_attachments_email_id");
		expect(detail).not.toMatch(/^SCAN attachments\b/m);
	});
});
