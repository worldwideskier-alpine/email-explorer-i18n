import { createExecutionContext, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	authenticatedFetch,
	createDummyMailbox,
	mailboxId,
	testAuthBeforeAll,
} from "./utils";

const PASSING_AUTH =
	"mx.test; spf=pass smtp.mailfrom=legit.com; dkim=pass header.i=@legit.com; dmarc=pass header.from=legit.com";

function buildRawEmail(headers: Record<string, string>, body: string): string {
	let raw = "";
	for (const [key, value] of Object.entries(headers)) {
		raw += `${key}: ${value}\r\n`;
	}
	raw += `\r\n${body}`;
	return raw;
}

async function receive(rawEmailStr: string, envelopeTo?: string) {
	const worker = await import("../../dev/index");
	const rawBytes = new TextEncoder().encode(rawEmailStr);
	const stream = new ReadableStream({
		start(controller) {
			controller.enqueue(rawBytes);
			controller.close();
		},
	});

	const rejections: string[] = [];
	await worker.default.email(
		{
			raw: stream,
			rawSize: rawBytes.length,
			to: envelopeTo,
			setReject: (reason: string) => rejections.push(reason),
		},
		env,
		createExecutionContext(),
	);
	return rejections;
}

async function mailboxExists(id: string): Promise<boolean> {
	// @ts-expect-error test binding
	return (await env.BUCKET.head(`mailboxes/${id}.json`)) !== null;
}

async function subjectsIn(folder: string, id = mailboxId): Promise<string[]> {
	const res = await authenticatedFetch(
		`http://local.test/api/v1/mailboxes/${id}/emails?folder=${folder}&limit=100`,
	);
	const emails = await res.json<any[]>();
	return emails.map((e) => e.subject);
}

// A "To:" header is written by the sender and says whatever the sender wants.
// Filing mail by that header put messages into mailboxes that were never ours
// -- one silently created per stray address, with no notification and no
// unread badge -- so delivery follows the envelope recipient instead.
describe("Incoming mail is filed by the envelope recipient", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
	});

	it("delivers to the envelope recipient even when the To: header names someone else", async () => {
		const stranger = "someone.else@other.example";
		const rawEmail = buildRawEmail(
			{
				From: "sender@legit.com",
				To: stranger,
				Subject: "Bcc'd to us, addressed to a stranger",
				"Content-Type": "text/plain",
				"Authentication-Results": PASSING_AUTH,
			},
			"body",
		);

		const rejections = await receive(rawEmail, mailboxId);

		expect(rejections).toEqual([]);
		expect(await subjectsIn("inbox")).toContain(
			"Bcc'd to us, addressed to a stranger",
		);
		expect(await mailboxExists(stranger)).toBe(false);
	});

	it("never creates a mailbox for an address that only appears in the To: header", async () => {
		const stranger = "te26.example@carrier.example";
		for (const n of [1, 2, 3]) {
			await receive(
				buildRawEmail(
					{
						From: "sender@legit.com",
						To: stranger,
						Subject: `Header-addressed ${n}`,
						"Content-Type": "text/plain",
						"Authentication-Results": PASSING_AUTH,
					},
					"body",
				),
				mailboxId,
			);
		}

		expect(await mailboxExists(stranger)).toBe(false);
		const inbox = await subjectsIn("inbox");
		for (const n of [1, 2, 3]) {
			expect(inbox).toContain(`Header-addressed ${n}`);
		}
	});

	it("rejects mail for an address that has no mailbox, without creating one", async () => {
		const unknown = "nobody@unconfigured.example";
		const rawEmail = buildRawEmail(
			{
				From: "sender@legit.com",
				To: unknown,
				Subject: "For an address we do not host",
				"Content-Type": "text/plain",
				"Authentication-Results": PASSING_AUTH,
			},
			"body",
		);

		const rejections = await receive(rawEmail, unknown);

		expect(rejections).toHaveLength(1);
		expect(rejections[0]).toContain(unknown);
		expect(await mailboxExists(unknown)).toBe(false);
		expect(await subjectsIn("inbox")).not.toContain(
			"For an address we do not host",
		);
	});

	it("matches the mailbox case-insensitively, rather than making a second one", async () => {
		const shouted = mailboxId.toUpperCase();
		const rawEmail = buildRawEmail(
			{
				From: "sender@legit.com",
				To: shouted,
				Subject: "Shouted envelope recipient",
				"Content-Type": "text/plain",
				"Authentication-Results": PASSING_AUTH,
			},
			"body",
		);

		const rejections = await receive(rawEmail, shouted);

		expect(rejections).toEqual([]);
		expect(await mailboxExists(shouted)).toBe(false);
		expect(await subjectsIn("inbox")).toContain("Shouted envelope recipient");
	});

	it("refuses a message that arrives with no envelope recipient at all", async () => {
		const rawEmail = buildRawEmail(
			{
				From: "sender@legit.com",
				To: mailboxId,
				Subject: "No envelope recipient",
				"Content-Type": "text/plain",
				"Authentication-Results": PASSING_AUTH,
			},
			"body",
		);

		await expect(receive(rawEmail, undefined)).rejects.toThrow(
			/envelope recipient/i,
		);
		expect(await subjectsIn("inbox")).not.toContain("No envelope recipient");
	});
});
