import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	authenticatedFetch,
	createDummyMailbox,
	mailboxId,
	testAuthBeforeAll,
} from "./utils";

/**
 * Restoring a backup, from the Worker's side: the import endpoint has to put a
 * message back where it was, keep the flags it had, and stay a no-op when the
 * same file is fed in a second time.
 */

function rawEmail(subject: string): string {
	return Buffer.from(
		[
			"From: sender@example.org",
			`To: ${mailboxId}`,
			`Subject: ${subject}`,
			"MIME-Version: 1.0",
			'Content-Type: text/plain; charset="utf-8"',
			"",
			"body",
			"",
		].join("\r\n"),
		"utf8",
	).toString("base64");
}

async function importEmail(body: Record<string, unknown>): Promise<Response> {
	return authenticatedFetch(
		`http://local.test/api/v1/admin/mailboxes/${mailboxId}/import`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ rawEmailBase64: rawEmail("Subject"), ...body }),
		},
	);
}

const getEmail = async (id: string) =>
	authenticatedFetch(
		`http://local.test/api/v1/mailboxes/${mailboxId}/emails/${id}`,
	);

const listFolders = async () =>
	(
		await (
			await authenticatedFetch(
				`http://local.test/api/v1/mailboxes/${mailboxId}/folders`,
			)
		).json<{ id: string; name: string }[]>()
	).map((row) => row.name);

/** Ids as a backup records them: minted here, so shaped like these. */
const ID = {
	kept1: "0f7e6d5c-0000-4000-8000-000000000001",
	kept2: "0f7e6d5c-0000-4000-8000-000000000002",
	sent: "0f7e6d5c-0000-4000-8000-000000000003",
	custom: "0f7e6d5c-0000-4000-8000-000000000004",
	fax1: "0f7e6d5c-0000-4000-8000-000000000005",
	fax2: "0f7e6d5c-0000-4000-8000-000000000006",
	flagged: "0f7e6d5c-0000-4000-8000-000000000007",
	dated: "0f7e6d5c-0000-4000-8000-000000000008",
	shared: "0f7e6d5c-0000-4000-8000-000000000009",
};

const idsInMailbox = async () =>
	// @ts-expect-error test binding
	(await env.MAILBOX.get(
		env.MAILBOX.idFromName(mailboxId),
	).listAllEmailIds()) as string[];

describe("Restoring mail into a mailbox", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
	});

	it("keeps the id the backup recorded", async () => {
		const res = await importEmail({ id: ID.kept1 });
		expect(res.status).toBe(201);
		expect((await res.json<{ id: string }>()).id).toBe(ID.kept1);
	});

	// The whole point of carrying the id: a restore that is run twice, or
	// resumed after failing halfway, must not double the mailbox.
	it("is a no-op the second time the same message is restored", async () => {
		expect((await importEmail({ id: ID.kept2 })).status).toBe(201);

		const again = await importEmail({ id: ID.kept2 });
		expect(again.status).toBe(200);
		expect((await again.json<{ status: string }>()).status).toBe("duplicate");
		// Said so, and meant it: one message, not two.
		expect(await idsInMailbox()).toEqual([ID.kept2]);
	});

	/**
	 * R2 keys carry the message id and no mailbox. Only the raw copy was
	 * checked before reusing an id, and sent mail has none -- so a message
	 * restored from another mailbox's backup took the original's id and
	 * shared its attachments, and deleting either one deleted both.
	 */
	it("does not take an id whose attachments are still stored", async () => {
		await env.BUCKET.put(`attachments/${ID.shared}/a/file.pdf`, "theirs");

		const res = await importEmail({ id: ID.shared });
		expect(res.status).toBe(201);
		const { id } = await res.json<{ id: string }>();
		expect(id).not.toBe(ID.shared);
		expect(id).toMatch(/^[0-9a-f-]{36}$/);
	});

	/** An id with a "/" in it names keys in somebody else's space. */
	it("does not take an id it could not have minted", async () => {
		for (const given of ["../escape", "a/b", "not-a-uuid"]) {
			const res = await importEmail({ id: given });
			expect(res.status).toBe(201);
			const { id } = await res.json<{ id: string }>();
			expect(id, given).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
			);
		}
	});

	it("still accepts a message with no id, as inbound mail has none", async () => {
		const res = await importEmail({});
		expect(res.status).toBe(201);
		expect((await res.json<{ id: string }>()).id).toMatch(/^[0-9a-f-]{36}$/);
	});

	it("puts the message back in the folder the backup names", async () => {
		// "Sent" is the display name; the row holds the id, "sent".
		const res = await importEmail({ folder: "Sent", id: ID.sent });
		expect(res.status).toBe(201);

		const email = await (await getEmail(ID.sent)).json<{
			folder_id: string;
		}>();
		expect(email.folder_id).toBe("sent");
	});

	// A restore into a fresh mailbox has to rebuild the folders too, or the
	// mail that lived in them has nowhere to go.
	it("creates a folder the backup names but the mailbox lacks", async () => {
		expect(await listFolders()).not.toContain("領収書類");

		const res = await importEmail({ folder: "領収書類", id: ID.custom });
		expect(res.status).toBe(201);

		expect(await listFolders()).toContain("領収書類");
		const email = await (await getEmail(ID.custom)).json<{
			folder_id: string;
		}>();
		const folders = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/folders`,
		);
		const made = (await folders.json<{ id: string; name: string }[]>()).find(
			(row) => row.name === "領収書類",
		);
		expect(email.folder_id).toBe(made?.id);
	});

	it("does not build a second folder beside one that already matches", async () => {
		await importEmail({ folder: "FAX", id: ID.fax1 });
		await importEmail({ folder: "FAX", id: ID.fax2 });

		const names = await listFolders();
		expect(names.filter((name) => name === "FAX")).toHaveLength(1);
	});

	it("puts read and starred back", async () => {
		await importEmail({ id: ID.flagged, read: true, starred: true });
		const email = await (await getEmail(ID.flagged)).json<{
			read: boolean;
			starred: boolean;
		}>();
		expect(email.read).toBe(true);
		expect(email.starred).toBe(true);
	});

	it("puts the original date back rather than stamping it now", async () => {
		await importEmail({ id: ID.dated, date: "2026-08-01T10:00:00.000Z" });
		const email = await (await getEmail(ID.dated)).json<{ date: string }>();
		expect(email.date).toBe("2026-08-01T10:00:00.000Z");
	});

	it("refuses a body that is not base64", async () => {
		const res = await authenticatedFetch(
			`http://local.test/api/v1/admin/mailboxes/${mailboxId}/import`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ rawEmailBase64: "not base64 at all!!" }),
			},
		);
		// The session here holds the mailbox, so this is the body check alone.
		// Who may import at all -- the mailbox's holder, whatever their role --
		// is administrators-are-equal.test.ts and legacy-admin-flag.test.ts.
		expect(res.status).toBe(400);
	});
});
