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

describe("Restoring mail into a mailbox", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
	});

	it("keeps the id the backup recorded", async () => {
		const res = await importEmail({ id: "kept-id-1" });
		expect(res.status).toBe(201);
		expect((await res.json<{ id: string }>()).id).toBe("kept-id-1");
	});

	// The whole point of carrying the id: a restore that is run twice, or
	// resumed after failing halfway, must not double the mailbox.
	it("is a no-op the second time the same message is restored", async () => {
		expect((await importEmail({ id: "kept-id-2" })).status).toBe(201);

		const again = await importEmail({ id: "kept-id-2" });
		expect(again.status).toBe(200);
		expect((await again.json<{ status: string }>()).status).toBe("duplicate");
	});

	it("still accepts a message with no id, as inbound mail has none", async () => {
		const res = await importEmail({});
		expect(res.status).toBe(201);
		expect((await res.json<{ id: string }>()).id).toMatch(/^[0-9a-f-]{36}$/);
	});

	it("puts the message back in the folder the backup names", async () => {
		// "Sent" is the display name; the row holds the id, "sent".
		const res = await importEmail({ folder: "Sent", id: "in-sent" });
		expect(res.status).toBe(201);

		const email = await (await getEmail("in-sent")).json<{
			folder_id: string;
		}>();
		expect(email.folder_id).toBe("sent");
	});

	// A restore into a fresh mailbox has to rebuild the folders too, or the
	// mail that lived in them has nowhere to go.
	it("creates a folder the backup names but the mailbox lacks", async () => {
		expect(await listFolders()).not.toContain("領収書類");

		const res = await importEmail({ folder: "領収書類", id: "in-custom" });
		expect(res.status).toBe(201);

		expect(await listFolders()).toContain("領収書類");
		const email = await (await getEmail("in-custom")).json<{
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
		await importEmail({ folder: "FAX", id: "custom-1" });
		await importEmail({ folder: "FAX", id: "custom-2" });

		const names = await listFolders();
		expect(names.filter((name) => name === "FAX")).toHaveLength(1);
	});

	it("puts read and starred back", async () => {
		await importEmail({ id: "flagged", read: true, starred: true });
		const email = await (await getEmail("flagged")).json<{
			read: boolean;
			starred: boolean;
		}>();
		expect(email.read).toBe(true);
		expect(email.starred).toBe(true);
	});

	it("puts the original date back rather than stamping it now", async () => {
		await importEmail({ id: "dated", date: "2026-08-01T10:00:00.000Z" });
		const email = await (await getEmail("dated")).json<{ date: string }>();
		expect(email.date).toBe("2026-08-01T10:00:00.000Z");
	});

	it("is still admin-only", async () => {
		const res = await authenticatedFetch(
			`http://local.test/api/v1/admin/mailboxes/${mailboxId}/import`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ rawEmailBase64: "not base64 at all!!" }),
			},
		);
		// The session used here is an admin, so this proves the body check, not
		// the role check; the role check has its own case in endpoints.test.ts.
		expect(res.status).toBe(400);
	});
});
