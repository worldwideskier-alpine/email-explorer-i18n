import { createExecutionContext, env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	authenticatedFetch,
	createDummyMailbox,
	createMailbox,
	mailboxId,
	testAuthBeforeAll,
} from "./utils";

function buildRawEmail(headers: Record<string, string>, body: string): string {
	let raw = "";
	for (const [key, value] of Object.entries(headers)) {
		raw += `${key}: ${value}\r\n`;
	}
	raw += `\r\n${body}`;
	return raw;
}

async function simulateReceiveEmail(
	rawEmailStr: string,
	envelopeTo: string = mailboxId,
) {
	const worker = await import("../../dev/index");
	const rawBytes = new TextEncoder().encode(rawEmailStr);
	const stream = new ReadableStream({
		start(controller) {
			controller.enqueue(rawBytes);
			controller.close();
		},
	});

	// The envelope recipient is what the worker files mail by; the "To:"
	// header inside rawEmailStr is deliberately allowed to say anything else.
	await worker.default.email(
		{ raw: stream, rawSize: rawBytes.length, to: envelopeTo },
		env,
		createExecutionContext(),
	);
}

/** A message written here and sent, which nothing stores an original of. */
async function composeOne(subject: string): Promise<string> {
	const sent = await authenticatedFetch(
		`http://local.test/api/v1/mailboxes/${mailboxId}/emails`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				to: ["recipient@example.net"],
				from: mailboxId,
				subject,
				text: "Written here",
			}),
		},
	);
	expect(sent.status).toBe(201);
	const { id } = await sent.json<{ id: string }>();
	// It is a message the mailbox has, so a 404 for its source is about the
	// source and not about the message.
	expect(
		(
			await authenticatedFetch(
				`http://local.test/api/v1/mailboxes/${mailboxId}/emails/${id}`,
			)
		).status,
	).toBe(200);
	return id;
}

describe("Original message source", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
	});

	it("returns the raw source for an email imported via the admin endpoint", async () => {
		// The mailbox has to exist and belong to somebody before mail is
		// pushed into it. Importing into an address nobody holds leaves the
		// mail where no screen can reach it -- see the note on the import
		// endpoint's guard.
		await createMailbox();
		const rawEmail = buildRawEmail(
			{
				From: "sender@example.com",
				To: mailboxId,
				Subject: "Imported source test",
				"Content-Type": "text/plain",
				"X-Custom-Header": "some-value",
			},
			"Body text",
		);
		const rawBase64 = btoa(rawEmail);

		const importResponse = await authenticatedFetch(
			`http://local.test/api/v1/admin/mailboxes/${mailboxId}/import`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ rawEmailBase64: rawBase64 }),
			},
		);
		expect(importResponse.status).toBe(201);
		const { id } = await importResponse.json<any>();

		const sourceResponse = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/emails/${id}/source`,
		);
		expect(sourceResponse.status).toBe(200);
		expect(sourceResponse.headers.get("Content-Type")).toContain("text/plain");
		const sourceText = await sourceResponse.text();
		expect(sourceText).toContain("X-Custom-Header: some-value");
		expect(sourceText).toContain("Body text");
	});

	it("returns the raw source for a real inbound email", async () => {
		await createDummyMailbox();

		const rawEmail = buildRawEmail(
			{
				From: "sender@example.com",
				To: mailboxId,
				Subject: "Inbound source test",
				"Content-Type": "text/plain",
				"Authentication-Results":
					"mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass",
			},
			"Inbound body",
		);

		await simulateReceiveEmail(rawEmail);

		const listResponse = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/emails?folder=inbox`,
		);
		const emails = await listResponse.json<any[]>();
		const received = emails.find(
			(e: any) => e.subject === "Inbound source test",
		);
		expect(received).toBeDefined();

		const sourceResponse = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/emails/${received.id}/source`,
		);
		expect(sourceResponse.status).toBe(200);
		const sourceText = await sourceResponse.text();
		expect(sourceText).toContain("Authentication-Results:");
		expect(sourceText).toContain("Inbound body");
	});

	/*
	 * A message that exists and has no original. This used to ask about an id
	 * with no message at all, which is a different 404 -- the one answered
	 * before the bucket is looked at -- so the case in its name was never
	 * reached.
	 */
	it("returns 404 when no raw source was stored (e.g. a locally composed message)", async () => {
		await createDummyMailbox();
		const id = await composeOne("Composed here");

		const sourceResponse = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/emails/${id}/source`,
		);
		expect(sourceResponse.status).toBe(404);
		expect(await sourceResponse.json()).toEqual({
			error: "Original source not available",
		});
	});

	it("returns 404 for a message the mailbox does not have", async () => {
		await createDummyMailbox();

		const sourceResponse = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/emails/nonexistent-id/source`,
		);
		expect(sourceResponse.status).toBe(404);
		expect(await sourceResponse.json()).toEqual({ error: "Not found" });
	});

	describe("Backfilling source onto an already-imported email (PUT .../source)", () => {
		/*
		 * The message used to be a received one, and ingest always stores an
		 * original, so "had none" was not true of it: the test overwrote a
		 * source rather than attaching one. A composed message has none.
		 */
		it("attaches raw source to an existing email that had none", async () => {
			await createDummyMailbox();
			const id = await composeOne("Backfill target");

			const source = () =>
				authenticatedFetch(
					`http://local.test/api/v1/mailboxes/${mailboxId}/emails/${id}/source`,
				);
			expect((await source()).status).toBe(404);

			const putResponse = await authenticatedFetch(
				`http://local.test/api/v1/mailboxes/${mailboxId}/emails/${id}/source`,
				{
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						rawEmailBase64: btoa("X-Backfilled: true\r\n\r\nBackfilled body"),
					}),
				},
			);
			expect(putResponse.status).toBe(204);

			const sourceResponse = await source();
			expect(sourceResponse.status).toBe(200);
			const sourceText = await sourceResponse.text();
			expect(sourceText).toContain("X-Backfilled: true");
			expect(sourceText).toContain("Backfilled body");
		});

		it("returns 404 when the target email does not exist", async () => {
			await createDummyMailbox();

			const putResponse = await authenticatedFetch(
				`http://local.test/api/v1/mailboxes/${mailboxId}/emails/nonexistent-id/source`,
				{
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ rawEmailBase64: btoa("body") }),
				},
			);
			expect(putResponse.status).toBe(404);
		});

		it("requires authentication", async () => {
			const res = await SELF.fetch(
				"http://local.test/api/v1/mailboxes/some-mailbox/emails/some-id/source",
				{
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ rawEmailBase64: btoa("body") }),
				},
			);
			expect(res.status).toBe(401);
		});
	});
});
