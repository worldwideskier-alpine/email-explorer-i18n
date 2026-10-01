import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { mailboxMigrations } from "../../src/durableObject/migrations";
import {
	authenticatedFetch,
	createMailbox,
	mailboxId,
	testAuthBeforeAll,
} from "./utils";

/**
 * The list marks a message that has been answered from here. The mark is set
 * when a reply leaves -- not when one is written, saved as a draft or
 * refused -- and replies sent before the mark existed are found by the copy
 * each left in Sent.
 */

const stub = () => env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));

async function place(
	id: string,
	folder: string,
	extra: { message_id?: string; in_reply_to?: string; date?: string } = {},
) {
	await runInDurableObject(stub(), async (_i, state) => {
		state.storage.sql.exec(
			`INSERT INTO emails (id, folder_id, subject, sender, recipient, date, body, message_id, in_reply_to)
			 VALUES (?, ?, ?, 'someone@example.org', ?, ?, '<p>b</p>', ?, ?)`,
			id,
			folder,
			`subject ${id}`,
			mailboxId,
			extra.date ?? new Date().toISOString(),
			extra.message_id ?? null,
			extra.in_reply_to ?? null,
		);
	});
}

async function listed(folder = "inbox") {
	const res = await authenticatedFetch(
		`http://local.test/api/v1/mailboxes/${mailboxId}/emails?folder=${folder}`,
	);
	expect(res.status).toBe(200);
	const rows = await res.json<{ id: string; replied_at?: string | null }[]>();
	return new Map(rows.map((r) => [r.id, r.replied_at ?? null]));
}

const send = (id: string, how: "reply" | "forward", subject = "Re: s") =>
	authenticatedFetch(
		`http://local.test/api/v1/mailboxes/${mailboxId}/emails/${id}/${how}`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				to: "someone@example.org",
				from: mailboxId,
				subject,
				html: "<p>reply</p>",
			}),
		},
	);

describe("the replied mark", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createMailbox();
	});

	it("is set on the message a reply answers, and on no other", async () => {
		await place("answered", "inbox", { message_id: "a@mail.example.org" });
		await place("forwarded", "inbox", { message_id: "f@mail.example.org" });
		await place("untouched", "inbox");

		const before = Date.now();
		expect((await send("answered", "reply")).status).toBe(201);
		expect((await send("forwarded", "forward", "Fwd: s")).status).toBe(201);

		const marks = await listed();
		const at = marks.get("answered");
		expect(at).toBeTypeOf("string");
		expect(Date.parse(at as string)).toBeGreaterThanOrEqual(before - 1000);
		// A forward is not an answer to the sender.
		expect(marks.get("forwarded")).toBeNull();
		expect(marks.get("untouched")).toBeNull();
	});

	it("is not set when the reply did not leave", async () => {
		await place("refused", "inbox", { message_id: "r@mail.example.org" });
		// The tests' Resend stub refuses this subject.
		const res = await send("refused", "reply", "Re: ECHO_RESEND_REQUEST");
		expect(res.status).toBe(500);
		expect((await listed()).get("refused")).toBeNull();
	});

	it("is found in search results too", async () => {
		await place("found", "inbox", { message_id: "s@mail.example.org" });
		expect((await send("found", "reply")).status).toBe(201);
		const res = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/search?query=${encodeURIComponent("subject found")}`,
		);
		expect(res.status).toBe(200);
		const rows = await res.json<{ id: string; replied_at?: string | null }[]>();
		expect(rows.find((r) => r.id === "found")?.replied_at).toBeTypeOf("string");
	});

	/**
	 * What the migration finds already answered: a reply copy in Sent names
	 * the message by the sender's Message-ID, or -- before replies were
	 * threaded that way -- by our own row id.
	 */
	it("is given to messages answered before it existed", async () => {
		await place("by-message-id", "inbox", { message_id: "m@mail.example.org" });
		await place("by-row-id", "archive");
		await place("unanswered", "inbox", { message_id: "u@mail.example.org" });
		await place("copy-1", "sent", {
			in_reply_to: "m@mail.example.org",
			date: "2026-09-01T10:00:00.000Z",
		});
		await place("copy-2", "sent", {
			in_reply_to: "m@mail.example.org",
			date: "2026-09-02T10:00:00.000Z",
		});
		await place("copy-3", "sent", {
			in_reply_to: "by-row-id",
			date: "2026-08-01T10:00:00.000Z",
		});

		const migration = mailboxMigrations.find((m) => m.name === "13_replied_at");
		await runInDurableObject(stub(), async (_i, state) => {
			// As the deployment's objects were before it: no column at all.
			state.storage.sql.exec("ALTER TABLE emails DROP COLUMN replied_at");
			state.storage.sql.exec(migration?.sql ?? "");
		});

		const marks = await listed();
		// The latest of its replies.
		expect(marks.get("by-message-id")).toBe("2026-09-02T10:00:00.000Z");
		expect(marks.get("unanswered")).toBeNull();
		expect((await listed("archive")).get("by-row-id")).toBe(
			"2026-08-01T10:00:00.000Z",
		);
		// The copies themselves are not answered messages.
		expect((await listed("sent")).get("copy-1")).toBeNull();
	});
});
