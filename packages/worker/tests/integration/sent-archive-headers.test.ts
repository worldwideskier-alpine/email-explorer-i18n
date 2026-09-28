import { env } from "cloudflare:test";
import PostalMime from "postal-mime";
import { beforeEach, describe, expect, it } from "vitest";
import { renderMboxEntry } from "../../src/mbox";
import {
	authenticatedFetch,
	createDummyMailbox,
	mailboxId,
	testAuthBeforeAll,
} from "./utils";

/**
 * A sent message in the archive, and back out of it.
 *
 * Mail composed here has no raw form, so its archive entry is rebuilt from the
 * row -- and only From, To, Subject and Date were. A sent reply with people on
 * Cc came back from the archive, which is the only copy once the message is
 * deleted, with nobody on Cc, no Bcc, and no In-Reply-To or References: cut
 * out of the thread it was part of.
 */

const sentReply = {
	id: "0f7e6d5c-0000-4000-8000-00000000c0c0",
	folder_id: "sent",
	subject: "Re: the plan",
	sender: mailboxId,
	recipient: "first@example.org",
	cc: "second@example.org, Third Person <third@example.org>",
	bcc: "quiet@example.org",
	in_reply_to: "original@mail.example.org",
	email_references: JSON.stringify([
		"root@mail.example.org",
		"original@mail.example.org",
	]),
	date: "2026-09-20T10:00:00.000Z",
	read: true,
	starred: false,
	body: "<p>Agreed.</p>",
	attachments: [],
};

/** The message in an entry, past the mbox separator line. */
async function messageOf(entry: Uint8Array): Promise<string> {
	const text = new TextDecoder().decode(entry);
	return text.slice(text.indexOf("\r\n") + 2);
}

describe("a sent message's archive entry", () => {
	it("carries who else it went to and what it answered", async () => {
		const parsed = await PostalMime.parse(
			await messageOf(await renderMboxEntry(env, sentReply as never, "Sent")),
		);

		expect(parsed.cc?.map((a) => a.address)).toEqual([
			"second@example.org",
			"third@example.org",
		]);
		expect(parsed.bcc?.map((a) => a.address)).toEqual(["quiet@example.org"]);
		expect(parsed.inReplyTo).toBe("<original@mail.example.org>");
		expect(parsed.references).toBe(
			"<root@mail.example.org> <original@mail.example.org>",
		);
	});

	it("leaves out what the row does not have", async () => {
		const plain = {
			...sentReply,
			cc: null,
			bcc: null,
			in_reply_to: null,
			email_references: null,
		};
		const message = await messageOf(
			await renderMboxEntry(env, plain as never, "Sent"),
		);
		expect(message).not.toMatch(/^(Cc|Bcc|In-Reply-To|References):/im);
	});
});

describe("restoring it", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
	});

	it("puts Cc, Bcc and the thread back on the row", async () => {
		const message = await messageOf(
			await renderMboxEntry(env, sentReply as never, "Sent"),
		);
		const bytes = new TextEncoder().encode(message);
		let binary = "";
		for (const b of bytes) binary += String.fromCharCode(b);

		const res = await authenticatedFetch(
			`http://local.test/api/v1/admin/mailboxes/${mailboxId}/import`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					folder: "Sent",
					rawEmailBase64: btoa(binary),
					id: sentReply.id,
				}),
			},
		);
		expect(res.status).toBe(201);
		const { id } = await res.json<{ id: string }>();

		const row = await (
			await authenticatedFetch(
				`http://local.test/api/v1/mailboxes/${mailboxId}/emails/${id}`,
			)
		).json<{
			cc: string | null;
			bcc: string | null;
			in_reply_to: string | null;
			email_references: string | null;
		}>();
		expect(row.cc).toContain("second@example.org");
		expect(row.cc).toContain("third@example.org");
		expect(row.bcc).toContain("quiet@example.org");
		expect(row.in_reply_to).toBe("original@mail.example.org");
		expect(JSON.parse(row.email_references ?? "[]")).toEqual([
			"root@mail.example.org",
			"original@mail.example.org",
		]);
	});

	// A Bcc: header on mail that arrived from outside is the sender's own
	// invention -- the sending server strips the real one -- and is not kept.
	it("keeps no Bcc on a message restored anywhere but Sent", async () => {
		const message = await messageOf(
			await renderMboxEntry(env, sentReply as never, "Sent"),
		);
		const res = await authenticatedFetch(
			`http://local.test/api/v1/admin/mailboxes/${mailboxId}/import`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					folder: "inbox",
					rawEmailBase64: btoa(message),
				}),
			},
		);
		const { id } = await res.json<{ id: string }>();
		const row = await (
			await authenticatedFetch(
				`http://local.test/api/v1/mailboxes/${mailboxId}/emails/${id}`,
			)
		).json<{ bcc: string | null }>();
		expect(row.bcc ?? null).toBeNull();
	});
});
