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

	/**
	 * And the response headers are not the sender's to write.
	 *
	 * The download route interpolated the stored name and type into
	 * `Content-Disposition` and `Content-Type` exactly as the mbox writer did:
	 * a quote in the name ends the parameter, so the browser saves the file
	 * under whatever came before it. RFC 6266 is the form for HTTP -- an ASCII
	 * fallback in quotes and the real name in `filename*`.
	 *
	 * The name arrives the way a real one would: an encoded word in the part's
	 * own header, which postal-mime decodes back to the quote and the kanji.
	 */
	it("does not let a filename rewrite the download headers", async () => {
		const awkward = '文書".pdf';
		const encoded = `=?UTF-8?B?${btoa(
			String.fromCharCode(...new TextEncoder().encode(awkward)),
		)}?=`;
		const message = [
			"From: sender@legit.com",
			`To: ${mailboxId}`,
			"Subject: a name with a quote in it",
			'Content-Type: multipart/mixed; boundary="b"',
			"",
			"--b",
			'Content-Type: text/plain; charset="utf-8"',
			"",
			"see attached",
			"--b",
			"Content-Type: application/octet-stream",
			`Content-Disposition: attachment; filename="${encoded}"`,
			"Content-Transfer-Encoding: base64",
			"",
			btoa(payload),
			"--b--",
		].join("\r\n");

		await receive(message, mailboxId);

		const list = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/emails?folder=inbox&limit=10`,
		);
		const emails = await list.json<{ id: string }[]>();
		const one = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/emails/${emails[0]?.id}`,
		);
		const parsed = await one.json<{
			id: string;
			attachments?: { id: string; filename: string }[];
		}>();
		expect(parsed.attachments?.[0]?.filename).toBe(awkward);

		const got = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/emails/${parsed.id}/attachments/${parsed.attachments?.[0]?.id}`,
		);
		expect(got.status).toBe(200);

		const disposition = got.headers.get("Content-Disposition") ?? "";
		// The quote does not reach the fallback, and the real name is carried
		// where a browser will read it.
		// Two kanji and a quote, each one character of the fallback.
		expect(disposition).toContain('filename="___.pdf"');
		expect(disposition).toContain(
			`filename*=UTF-8''${encodeURIComponent(awkward)}`,
		);
		expect(await got.text()).toBe(payload);
	});

	/**
	 * And the stored type cannot become the response's type.
	 *
	 * `type` is an unvalidated string on the send API, so a composed message
	 * can carry any of it into the row. Received mail cannot reach this state
	 * -- the parser hands back a bare type -- which is why the row is written
	 * here directly: it is the state the product can produce, not a shape
	 * invented for the test.
	 */
	it("does not let a stored type dictate the response type", async () => {
		const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
		const emailId = crypto.randomUUID();
		const attachmentId = crypto.randomUUID();
		const filename = 'a"; name="x.txt';

		await env.BUCKET.put(
			`attachments/${emailId}/${attachmentId}/${filename}`,
			payload,
		);
		await stub.createEmail(
			"inbox",
			{
				id: emailId,
				subject: "composed with an awkward type",
				sender: "me@example.test",
				recipient: mailboxId,
				date: new Date().toISOString(),
				body: "<p>hello</p>",
			} as never,
			[
				{
					id: attachmentId,
					email_id: emailId,
					filename,
					mimetype: 'multipart/mixed; boundary="zz"',
					size: payload.length,
					content_id: null,
					disposition: "attachment",
				},
			] as never,
		);

		const got = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/emails/${emailId}/attachments/${attachmentId}`,
		);

		expect(got.status).toBe(200);
		expect(got.headers.get("Content-Type")).toBe("application/octet-stream");
		const disposition = got.headers.get("Content-Disposition") ?? "";
		// The quote is out of the fallback, so there is one filename parameter.
		expect(disposition.match(/filename="/g)?.length).toBe(1);
		expect(await got.text()).toBe(payload);
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
