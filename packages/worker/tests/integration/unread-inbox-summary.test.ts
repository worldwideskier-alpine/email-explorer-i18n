import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	authenticatedFetch,
	createMailbox,
	mailboxId,
	testAuthBeforeAll,
} from "./utils";

async function insertInboxEmail(
	id: string,
	subject: string,
	sender: string,
	date: string,
) {
	// @ts-expect-error
	const doId = env.MAILBOX.idFromName(mailboxId);
	// @ts-expect-error
	const doStub = env.MAILBOX.get(doId);
	await runInDurableObject(doStub, async (_instance, state) => {
		state.storage.sql.exec(
			`INSERT INTO emails (id, folder_id, subject, sender, recipient, date, body, read)
			 VALUES (?, 'inbox', ?, ?, ?, ?, '<p>Body</p>', 0)`,
			id,
			subject,
			sender,
			mailboxId,
			date,
		);
	});
}

async function getSummary() {
	// @ts-expect-error
	const doId = env.MAILBOX.idFromName(mailboxId);
	// @ts-expect-error
	const doStub = env.MAILBOX.get(doId);
	return doStub.getUnreadInboxSummary();
}

describe("Unread inbox summary (per-mailbox aggregate notification data)", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createMailbox();
	});

	it("returns null when there is nothing unread", async () => {
		expect(await getSummary()).toBeNull();
	});

	it("counts multiple unread emails and surfaces the most recent one", async () => {
		const id1 = crypto.randomUUID();
		const id2 = crypto.randomUUID();
		await insertInboxEmail(
			id1,
			"First email",
			"a@example.com",
			"2026-01-01T00:00:00.000Z",
		);
		await insertInboxEmail(
			id2,
			"Second email",
			"b@example.com",
			"2026-01-02T00:00:00.000Z",
		);

		const summary = await getSummary();
		expect(summary).toEqual({
			count: 2,
			latestId: id2,
			latestSender: "b@example.com",
			latestSubject: "Second email",
		});
	});

	it("decrements as emails are marked read, and returns to null once all are read", async () => {
		const id1 = crypto.randomUUID();
		const id2 = crypto.randomUUID();
		await insertInboxEmail(
			id1,
			"First email",
			"a@example.com",
			"2026-01-01T00:00:00.000Z",
		);
		await insertInboxEmail(
			id2,
			"Second email",
			"b@example.com",
			"2026-01-02T00:00:00.000Z",
		);

		expect((await getSummary())?.count).toBe(2);

		await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/emails/${id1}`,
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ read: true }),
			},
		);
		expect((await getSummary())?.count).toBe(1);

		await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/emails/${id2}`,
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ read: true }),
			},
		);
		expect(await getSummary()).toBeNull();
	});

	it("ignores emails outside the inbox folder", async () => {
		// @ts-expect-error
		const doId = env.MAILBOX.idFromName(mailboxId);
		// @ts-expect-error
		const doStub = env.MAILBOX.get(doId);
		await runInDurableObject(doStub, async (_instance, state) => {
			state.storage.sql.exec(
				`INSERT INTO emails (id, folder_id, subject, sender, recipient, date, body, read)
				 VALUES (?, 'archive', 'Archived unread', 'a@example.com', ?, ?, '<p>Body</p>', 0)`,
				crypto.randomUUID(),
				mailboxId,
				new Date().toISOString(),
			);
		});

		expect(await getSummary()).toBeNull();
	});
});
