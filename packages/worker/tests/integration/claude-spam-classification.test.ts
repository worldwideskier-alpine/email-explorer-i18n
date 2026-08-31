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

async function folderOf(subject: string): Promise<string | undefined> {
	for (const folder of ["inbox", "spam"]) {
		const res = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/emails?folder=${folder}`,
		);
		const emails = await res.json<any[]>();
		if (emails.some((e: any) => e.subject === subject)) return folder;
	}
	return undefined;
}

async function setClaudeApiKey(apiKey: string) {
	await authenticatedFetch(`http://local.test/api/v1/mailboxes/${mailboxId}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ settings: { spamFilter: { claudeApiKey: apiKey } } }),
	});
}

describe("Claude second-stage spam classification", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
	});

	it("skips Claude entirely when no API key is configured, even if it would say SPAM", async () => {
		// No claudeApiKey set on this mailbox. The stub (see vitest.config.mts)
		// would return SPAM given the TRIGGER_CLAUDE_SPAM marker below, so
		// landing in inbox proves Claude was never called.
		const rawEmail = buildRawEmail(
			{
				From: "sender@legit.com",
				To: mailboxId,
				Subject: "No key configured TRIGGER_CLAUDE_SPAM",
				"Content-Type": "text/plain",
				"Authentication-Results": PASSING_AUTH_RESULTS,
			},
			"Hello",
		);

		await simulateReceiveEmail(rawEmail);

		expect(await folderOf("No key configured TRIGGER_CLAUDE_SPAM")).toBe(
			"inbox",
		);
	});

	it("routes to spam when Claude says SPAM and an API key is configured", async () => {
		await setClaudeApiKey("sk-ant-test-key");

		const rawEmail = buildRawEmail(
			{
				From: "sender@legit.com",
				To: mailboxId,
				Subject: "Claude flags spam TRIGGER_CLAUDE_SPAM",
				"Content-Type": "text/plain",
				"Authentication-Results": PASSING_AUTH_RESULTS,
			},
			"Hello",
		);

		await simulateReceiveEmail(rawEmail);

		expect(await folderOf("Claude flags spam TRIGGER_CLAUDE_SPAM")).toBe(
			"spam",
		);
	});

	it("keeps mail in inbox when Claude says NOT_SPAM and an API key is configured", async () => {
		await setClaudeApiKey("sk-ant-test-key");

		const rawEmail = buildRawEmail(
			{
				From: "sender@legit.com",
				To: mailboxId,
				Subject: "Claude clears it",
				"Content-Type": "text/plain",
				"Authentication-Results": PASSING_AUTH_RESULTS,
			},
			"Hello",
		);

		await simulateReceiveEmail(rawEmail);

		expect(await folderOf("Claude clears it")).toBe("inbox");
	});

	it("never calls Claude for mail that already failed SPF/DKIM, even with a key configured", async () => {
		await setClaudeApiKey("sk-ant-test-key");

		// The stub returns NOT_SPAM by default (no TRIGGER_CLAUDE_SPAM marker),
		// so landing in spam proves the stage-1 failure short-circuited before
		// Claude could clear it.
		const rawEmail = buildRawEmail(
			{
				From: "sender@spoofed.com",
				To: mailboxId,
				Subject: "Stage 1 already failed",
				"Content-Type": "text/plain",
				"Authentication-Results": FAILING_AUTH_RESULTS,
			},
			"Hello",
		);

		await simulateReceiveEmail(rawEmail);

		expect(await folderOf("Stage 1 already failed")).toBe("spam");
	});

	it("skips Claude for a DMARC-aligned sender on the mailbox's own domain, even if Claude would say SPAM", async () => {
		await setClaudeApiKey("sk-ant-test-key");

		// mailboxId is test@example.com (see utils.ts) -- From shares that
		// domain and DMARC is aligned, so this should never reach Claude even
		// though the stub would return SPAM for the TRIGGER_CLAUDE_SPAM marker.
		const rawEmail = buildRawEmail(
			{
				From: "noreply@example.com",
				To: mailboxId,
				Subject: "Self-domain transactional mail TRIGGER_CLAUDE_SPAM",
				"Content-Type": "text/plain",
				"Authentication-Results":
					"mx.example.com; spf=pass smtp.mailfrom=example.com; dkim=pass header.i=@example.com; dmarc=pass header.from=example.com",
			},
			"Hello",
		);

		await simulateReceiveEmail(rawEmail);

		expect(
			await folderOf("Self-domain transactional mail TRIGGER_CLAUDE_SPAM"),
		).toBe("inbox");
	});

	it("still calls Claude for a different domain, even if DMARC passes there too", async () => {
		await setClaudeApiKey("sk-ant-test-key");

		const rawEmail = buildRawEmail(
			{
				From: "sender@legit.com",
				To: mailboxId,
				Subject: "Different domain TRIGGER_CLAUDE_SPAM",
				"Content-Type": "text/plain",
				"Authentication-Results": PASSING_AUTH_RESULTS,
			},
			"Hello",
		);

		await simulateReceiveEmail(rawEmail);

		expect(await folderOf("Different domain TRIGGER_CLAUDE_SPAM")).toBe(
			"spam",
		);
	});

	it("fails open to inbox when the Claude API call errors", async () => {
		await setClaudeApiKey("sk-ant-test-key");

		const rawEmail = buildRawEmail(
			{
				From: "sender@legit.com",
				To: mailboxId,
				Subject: "Claude API errors out TRIGGER_CLAUDE_ERROR",
				"Content-Type": "text/plain",
				"Authentication-Results": PASSING_AUTH_RESULTS,
			},
			"Hello",
		);

		await simulateReceiveEmail(rawEmail);

		expect(await folderOf("Claude API errors out TRIGGER_CLAUDE_ERROR")).toBe(
			"inbox",
		);
	});

	/**
	 * These two ride on how the stub decides its verdict: it answers SPAM when
	 * the marker appears anywhere in the request body. Putting the marker in a
	 * field rather than in the subject turns "did this field reach the API at
	 * all" into something the folder can answer.
	 *
	 * Both cover the gap a message impersonating a card issuer walked through:
	 * it authenticated cleanly on a domain its sender owned, and everything
	 * that would have given it away -- the display name, the failed signature,
	 * the absent DMARC policy -- was dropped before the classifier saw it.
	 */
	describe("what reaches the classifier", () => {
		it("passes the sender's display name, not just the address", async () => {
			await setClaudeApiKey("sk-ant-test-key");

			const rawEmail = buildRawEmail(
				{
					// Encoded exactly as an impersonating display name arrives:
					// RFC 2047, so the name only exists once postal-mime decodes it.
					From: `=?UTF-8?B?${Buffer.from("TRIGGER_CLAUDE_SPAM", "utf8").toString("base64")}?= <sender@legit.com>`,
					To: mailboxId,
					Subject: "Display name reaches the classifier",
					"Content-Type": "text/plain",
					"Authentication-Results": PASSING_AUTH_RESULTS,
				},
				"Hello",
			);

			await simulateReceiveEmail(rawEmail);

			// Nothing else in this message carries the marker: the subject, the
			// body and the address are all clean. Landing in spam is only
			// possible if the decoded display name was sent.
			expect(await folderOf("Display name reaches the classifier")).toBe(
				"spam",
			);
		});

		it("passes the authentication verdicts", async () => {
			await setClaudeApiKey("sk-ant-test-key");

			const rawEmail = buildRawEmail(
				{
					From: "sender@legit.com",
					To: mailboxId,
					Subject: "Auth verdicts reach the classifier",
					"Content-Type": "text/plain",
					// A verdict value is whatever word the relay wrote there, so
					// the marker travels the same route a real "fail" does: read
					// out of the header by summarizeAuthResults, put on the
					// Authentication line, sent. It is not one of the values the
					// first pass files mail on, so stage 1 lets this through.
					"Authentication-Results":
						"mx.example.com; spf=pass smtp.mailfrom=legit.com; dkim=TRIGGER_CLAUDE_SPAM header.i=@legit.com; dmarc=pass header.from=legit.com",
				},
				"Hello",
			);

			await simulateReceiveEmail(rawEmail);

			expect(await folderOf("Auth verdicts reach the classifier")).toBe(
				"spam",
			);
		});
	});
});
