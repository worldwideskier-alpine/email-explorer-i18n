import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createDummyMailbox, mailboxId, testAuthBeforeAll } from "./utils";

/**
 * The two questions a mailbox is asked most -- one folder's mail, newest
 * first, and one message's attachments -- each read the whole table: there
 * was no index on either. SQLite's own plan says which it does.
 */

async function plan(sql: string, ...params: unknown[]): Promise<string> {
	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
	// Asked once through the stub first, so the object has applied its
	// migrations before its storage is read directly.
	await stub.getFolders();
	return runInDurableObject(stub, async (_i, state) =>
		state.storage.sql
			.exec(`EXPLAIN QUERY PLAN ${sql}`, ...params)
			.toArray()
			.map((row) => String(row.detail))
			.join("\n"),
	);
}

describe("a mailbox's storage", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
	});

	it("finds one folder's mail, newest first, without reading the rest", async () => {
		const detail = await plan(
			"SELECT id FROM emails WHERE folder_id = ? ORDER BY date DESC LIMIT 50",
			"inbox",
		);
		expect(detail).toContain("idx_emails_folder_date");
		expect(detail).not.toMatch(/^SCAN emails\b/m);
		expect(detail).not.toContain("TEMP B-TREE");
	});

	it("finds a message's attachments without reading every one", async () => {
		const detail = await plan(
			"SELECT * FROM attachments WHERE email_id = ?",
			"some-id",
		);
		expect(detail).toContain("idx_attachments_email_id");
		expect(detail).not.toMatch(/^SCAN attachments\b/m);
	});
});
