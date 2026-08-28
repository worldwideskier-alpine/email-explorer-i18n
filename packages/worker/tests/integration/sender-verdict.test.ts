import { env, createExecutionContext } from "cloudflare:test";
import { describe, expect, it, beforeEach } from "vitest";
import {
	authenticatedFetch,
	createDummyMailbox,
	mailboxId,
	testAuthBeforeAll,
} from "./utils";

const PASSING_AUTH_RESULTS =
	"mx.example.com; spf=pass smtp.mailfrom=legit.com; dkim=pass header.i=@legit.com; dmarc=pass header.from=legit.com";
const FAILING_AUTH_RESULTS =
	"mx.example.com; spf=fail smtp.mailfrom=spoofed.com; dkim=fail header.i=@other.com";

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

async function findEmail(
	subject: string,
): Promise<{ id: string; folder: string } | undefined> {
	for (const folder of ["inbox", "spam"]) {
		const res = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/emails?folder=${folder}`,
		);
		const emails = await res.json<any[]>();
		const match = emails.find((e: any) => e.subject === subject);
		if (match) return { id: match.id, folder };
	}
	return undefined;
}

describe("Sender-based spam verdict override", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
	});

	it("moves an email to spam and remembers the sender when marked spam", async () => {
		await simulateReceiveEmail(
			buildRawEmail(
				{
					From: "repeat-offender@example.net",
					To: mailboxId,
					Subject: "First contact",
					"Content-Type": "text/plain",
					"Authentication-Results": PASSING_AUTH_RESULTS,
				},
				"Hello",
			),
		);

		const found = await findEmail("First contact");
		expect(found?.folder).toBe("inbox");

		const verdictRes = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/emails/${found?.id}/spam-verdict`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ verdict: "spam" }),
			},
		);
		expect(verdictRes.status).toBe(200);
		expect((await findEmail("First contact"))?.folder).toBe("spam");

		// A brand-new, fully-authenticated email from the exact same sender
		// should now go straight to spam, without even consulting SPF/DKIM/DMARC.
		await simulateReceiveEmail(
			buildRawEmail(
				{
					From: "repeat-offender@example.net",
					To: mailboxId,
					Subject: "Second contact, still passes auth",
					"Content-Type": "text/plain",
					"Authentication-Results": PASSING_AUTH_RESULTS,
				},
				"Hello again",
			),
		);
		expect(await findEmail("Second contact, still passes auth")).toEqual({
			id: expect.any(String),
			folder: "spam",
		});
	});

	it("moves an email to inbox and remembers the sender when marked not-spam", async () => {
		await simulateReceiveEmail(
			buildRawEmail(
				{
					From: "false-positive@example.net",
					To: mailboxId,
					Subject: "Wrongly flagged",
					"Content-Type": "text/plain",
					"Authentication-Results": FAILING_AUTH_RESULTS,
				},
				"Hello",
			),
		);

		const found = await findEmail("Wrongly flagged");
		expect(found?.folder).toBe("spam");

		const verdictRes = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/emails/${found?.id}/spam-verdict`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ verdict: "not-spam" }),
			},
		);
		expect(verdictRes.status).toBe(200);
		expect((await findEmail("Wrongly flagged"))?.folder).toBe("inbox");

		// A brand-new email from the same sender, still failing SPF/DKIM/DMARC,
		// should now go straight to inbox because of the remembered override.
		await simulateReceiveEmail(
			buildRawEmail(
				{
					From: "false-positive@example.net",
					To: mailboxId,
					Subject: "Second message, still fails auth",
					"Content-Type": "text/plain",
					"Authentication-Results": FAILING_AUTH_RESULTS,
				},
				"Hello again",
			),
		);
		expect(await findEmail("Second message, still fails auth")).toEqual({
			id: expect.any(String),
			folder: "inbox",
		});
	});

	it("a spam verdict short-circuits before Claude is ever consulted", async () => {
		await authenticatedFetch(`http://local.test/api/v1/mailboxes/${mailboxId}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ settings: { spamFilter: { claudeApiKey: "sk-ant-test-key" } } }),
		});

		await simulateReceiveEmail(
			buildRawEmail(
				{
					From: "blocked@example.net",
					To: mailboxId,
					Subject: "Initial",
					"Content-Type": "text/plain",
					"Authentication-Results": PASSING_AUTH_RESULTS,
				},
				"Hello",
			),
		);
		const found = await findEmail("Initial");
		await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/emails/${found?.id}/spam-verdict`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ verdict: "spam" }),
			},
		);

		// No TRIGGER_CLAUDE_SPAM marker -- the stub would say NOT_SPAM if Claude
		// were consulted. Landing in spam anyway proves the sender override
		// took precedence and Claude was never called.
		await simulateReceiveEmail(
			buildRawEmail(
				{
					From: "blocked@example.net",
					To: mailboxId,
					Subject: "Follow-up, Claude would clear this",
					"Content-Type": "text/plain",
					"Authentication-Results": PASSING_AUTH_RESULTS,
				},
				"Hello again",
			),
		);
		expect(await findEmail("Follow-up, Claude would clear this")).toEqual({
			id: expect.any(String),
			folder: "spam",
		});
	});

	it("returns 404 for an unknown email id", async () => {
		const res = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/emails/does-not-exist/spam-verdict`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ verdict: "spam" }),
			},
		);
		expect(res.status).toBe(404);
	});
});
