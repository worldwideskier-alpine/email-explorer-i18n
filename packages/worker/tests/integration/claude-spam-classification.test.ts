import { env, createExecutionContext } from "cloudflare:test";
import { describe, expect, it, beforeEach } from "vitest";
import { authenticatedFetch, mailboxId, testAuthBeforeAll } from "./utils";

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
		await authenticatedFetch("http://local.test/api/v1/debug/create-mailbox", { method: "POST" });
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
});
