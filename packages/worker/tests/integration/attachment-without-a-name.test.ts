import { createExecutionContext, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	authenticatedFetch,
	createDummyMailbox,
	mailboxId,
	testAuthBeforeAll,
} from "./utils";

/**
 * An attachment that arrives without a filename.
 *
 * The key and the row disagreed about what it is called. `email-ingest.ts`
 * wrote it to `attachments/{emailId}/{attachmentId}/${att.filename}` -- the
 * raw value, so `.../undefined` -- and recorded `att.filename || "untitled"`
 * in the row. Everything that reads goes through the row, so it looked for
 * `.../untitled` and found nothing.
 *
 * The bytes are in the bucket the whole time. What is broken is the name they
 * were filed under, which makes them unreachable by the download route, by the
 * mbox archive, and by the deletes that are supposed to remove them when the
 * mailbox is destroyed -- so they also outlive the account that owned them.
 *
 * Not a rare shape: `Content-Disposition: attachment` with no `filename` is
 * legal, and inline images referenced only by Content-ID routinely have none.
 */

const PASSING_AUTH =
	"mx.test; spf=pass smtp.mailfrom=legit.com; dkim=pass header.i=@legit.com; dmarc=pass header.from=legit.com";

const payload = "the bytes nobody could name";

const raw = (to: string) =>
	[
		"From: sender@legit.com",
		`To: ${to}`,
		"Subject: an attachment with no name",
		'Content-Type: multipart/mixed; boundary="b"',
		"",
		"--b",
		'Content-Type: text/plain; charset="utf-8"',
		"",
		"see attached",
		"--b",
		"Content-Type: application/octet-stream",
		// No filename, which is the whole of the case.
		"Content-Disposition: attachment",
		"Content-Transfer-Encoding: base64",
		"",
		btoa(payload),
		"--b--",
	].join("\r\n");

async function receive(message: string, to: string) {
	const worker = await import("../../dev/index");
	const bytes = new TextEncoder().encode(message);
	await worker.default.email(
		{
			raw: new ReadableStream({
				start(controller) {
					controller.enqueue(bytes);
					controller.close();
				},
			}),
			rawSize: bytes.length,
			to,
			headers: new Headers({ "Authentication-Results": PASSING_AUTH }),
			setReject: () => {},
		} as never,
		env,
		createExecutionContext(),
	);
}

describe("an attachment that arrived without a filename", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
	});

	it("is filed under the name the row records", async () => {
		await receive(raw(mailboxId), mailboxId);

		const list = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/emails?folder=inbox&limit=10`,
		);
		const emails = await list.json<{ id: string }[]>();
		const one = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/emails/${emails[0]?.id}`,
		);
		const message = await one.json<{
			id: string;
			attachments?: { id: string; filename: string }[];
		}>();
		const attachment = message.attachments?.[0];
		expect(attachment).toBeTruthy();

		/*
		 * The whole property, and not a guess at the wrong name: whatever the
		 * row calls it, the bytes are under that. Checking only that no key
		 * ends in "undefined" passes when the missing name lands as "null"
		 * instead -- which is what this parser gives, so that check was empty.
		 */
		const key = `attachments/${message.id}/${attachment?.id}/${attachment?.filename}`;
		expect(await env.BUCKET.head(key), key).toBeTruthy();
	});

	// And so the bytes can actually be fetched, which is the point of the name.
	it("can be downloaded through the route that reads the row", async () => {
		await receive(raw(mailboxId), mailboxId);

		const list = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/emails?folder=inbox&limit=10`,
		);
		const emails = await list.json<{ id: string }[]>();
		expect(emails.length).toBeGreaterThan(0);

		// The list view carries no attachments; the single message does.
		const one = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/emails/${emails[0]?.id}`,
		);
		const message = await one.json<{
			id: string;
			attachments?: { id: string; filename: string }[];
		}>();
		expect(message.attachments?.length).toBe(1);

		const attachmentId = message.attachments?.[0]?.id as string;
		const got = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/emails/${message.id}/attachments/${attachmentId}`,
		);

		expect(got.status).toBe(200);
		expect(await got.text()).toBe(payload);
	});
});
