import { createExecutionContext, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	authenticatedFetch,
	createDummyMailbox,
	mailboxId,
	testAuthBeforeAll,
} from "./utils";

/**
 * A From that the parser reads differently from the verifier that wrote the
 * Authentication-Results line. What this Worker decides on is postal-mime's
 * `from.address`: a sender at the mailbox's own domain is trusted
 * (isTrustedSelfDomainSender) and one marked "not spam" skips the checks, so
 * a shape the verifier reads as the attacker's own domain but the parser
 * reads as one of those skipped the Claude check and landed in the inbox.
 * On postal-mime 4.0.0 all four shapes below did; on 4.0.8, which fixes the
 * high advisory, three still did; 4.1.4 reads none of them so (measured).
 *
 * The Authentication-Results lines are what a verifier that reads the raw
 * From the way Python or Go do would write. How Cloudflare's own DMARC reads
 * these shapes has not been measured, so how large the gap was in
 * production is inferred, not observed. mailboxId is at example.com, which
 * makes example.com the mailbox's own domain.
 */
const PASS_ATTACKER =
	"Authentication-Results: mx.cloudflare.net; spf=pass smtp.mailfrom=attacker.example; dkim=pass header.i=@attacker.example; dmarc=pass header.from=attacker.example";
const NONE_ATTACKER =
	"Authentication-Results: mx.cloudflare.net; spf=pass smtp.mailfrom=attacker.example; dkim=pass header.i=@attacker.example; dmarc=none";
const FAILING =
	"Authentication-Results: mx.cloudflare.net; spf=fail smtp.mailfrom=spoofed.com; dkim=fail header.i=@other.com";

async function receive(lines: string[]) {
	const bytes = new TextEncoder().encode(`${lines.join("\r\n")}\r\n\r\nHello`);
	const worker = await import("../../dev/index");
	await worker.default.email(
		{
			raw: new ReadableStream({
				start(c) {
					c.enqueue(bytes);
					c.close();
				},
			}),
			rawSize: bytes.length,
			to: mailboxId,
		},
		env,
		createExecutionContext(),
	);
}

interface Listed {
	id: string;
	subject: string;
	sender: string;
}

async function find(subject: string) {
	for (const folder of ["inbox", "spam"]) {
		const emails = await (
			await authenticatedFetch(
				`http://local.test/api/v1/mailboxes/${mailboxId}/emails?folder=${folder}`,
			)
		).json<Listed[]>();
		const match = emails.find((e) => e.subject === subject);
		if (match) return { folder, sender: match.sender, id: match.id };
	}
	return undefined;
}

// The test Claude stub calls a subject with TRIGGER_CLAUDE_SPAM in it spam,
// so a message that reached the check lands in spam.
async function setClaudeApiKey() {
	await authenticatedFetch(`http://local.test/api/v1/mailboxes/${mailboxId}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			settings: { spamFilter: { claudeApiKey: "sk-ant-test-key" } },
		}),
	});
}

const b64 = (s: string) =>
	btoa(String.fromCharCode(...new TextEncoder().encode(s)));

describe("sender shapes a DMARC verifier reads differently", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
		await setClaudeApiKey();
	});

	const shapes: [string, string[]][] = [
		[
			"a 'From :' before the real From",
			["From : ceo@example.com", "From: x@attacker.example"],
		],
		[
			"a nested comment",
			["From: Victim (x(y) <ceo@example.com>) <x@attacker.example>"],
		],
		[
			"an escaped parenthesis",
			["From: (x\\) <ceo@example.com>) Victim <x@attacker.example>"],
		],
	];
	for (const [name, from] of shapes) {
		it(`is not read as the mailbox's own domain: ${name}`, async () => {
			const subject = `Spoof ${name} TRIGGER_CLAUDE_SPAM`;
			await receive([
				PASS_ATTACKER,
				...from,
				`To: ${mailboxId}`,
				`Subject: ${subject}`,
				"Content-Type: text/plain",
			]);
			const got = await find(subject);
			expect(got?.sender).not.toBe("ceo@example.com");
			expect(got?.folder).toBe("spam");
		});
	}

	it("does not inherit a not-spam verdict through an encoded-word mailbox", async () => {
		await receive([
			FAILING,
			"From: statements@bank.example",
			`To: ${mailboxId}`,
			"Subject: Genuine",
			"Content-Type: text/plain",
		]);
		const genuine = await find("Genuine");
		const marked = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/emails/${genuine?.id}/spam-verdict`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ verdict: "not-spam" }),
			},
		);
		expect(marked.ok).toBe(true);
		const subject = "Spoof encoded TRIGGER_CLAUDE_SPAM";
		await receive([
			NONE_ATTACKER,
			`From: =?utf-8?B?${b64("Statements <statements@bank.example>")}?=`,
			`To: ${mailboxId}`,
			`Subject: ${subject}`,
			"Content-Type: text/plain",
		]);
		const got = await find(subject);
		expect(got?.sender).not.toBe("statements@bank.example");
		expect(got?.folder).toBe("spam");
	});
});
