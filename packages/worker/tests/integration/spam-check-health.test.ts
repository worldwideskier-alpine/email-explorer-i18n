import { createExecutionContext, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	authenticatedFetch,
	createDummyMailbox,
	mailboxId,
	testAuthBeforeAll,
} from "./utils";

/**
 * Whether the second-stage spam check is still working.
 *
 * It fails open on purpose -- a flaky API call must never lose real mail --
 * but failing open used to be silent. A key that had been revoked produced a
 * console line nobody reads, every message went to the inbox, and the
 * settings screen went on showing the key as configured. A filter that had
 * stopped running was indistinguishable from one finding nothing to catch.
 *
 * So each run is recorded, and the mailbox endpoint reports it.
 */

const PASSING_AUTH_RESULTS =
	"mx.example.com; spf=pass smtp.mailfrom=legit.com; dkim=pass header.i=@legit.com; dmarc=pass header.from=legit.com";

function buildRawEmail(headers: Record<string, string>, body: string): string {
	let raw = "";
	for (const [key, value] of Object.entries(headers)) {
		raw += `${key}: ${value}\r\n`;
	}
	return `${raw}\r\n${body}`;
}

async function receive(subject: string) {
	const worker = await import("../../dev/index");
	const raw = buildRawEmail(
		{
			From: "sender@legit.com",
			To: mailboxId,
			Subject: subject,
			"Content-Type": "text/plain",
			"Authentication-Results": PASSING_AUTH_RESULTS,
		},
		"Hello",
	);
	const bytes = new TextEncoder().encode(raw);
	await worker.default.email(
		{
			raw: new ReadableStream({
				start(controller) {
					controller.enqueue(bytes);
					controller.close();
				},
			}),
			rawSize: bytes.length,
			to: mailboxId,
		},
		env,
		createExecutionContext(),
	);
}

async function setClaudeApiKey(apiKey: string) {
	await authenticatedFetch(`http://local.test/api/v1/mailboxes/${mailboxId}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ settings: { spamFilter: { claudeApiKey: apiKey } } }),
	});
}

async function health() {
	const res = await authenticatedFetch(
		`http://local.test/api/v1/mailboxes/${mailboxId}`,
	);
	return (
		await res.json<{
			spamCheck: {
				lastSuccessAt: string | null;
				lastFailureAt: string | null;
				lastFailureReason: string | null;
			};
		}>()
	).spamCheck;
}

describe("the second-stage check reports whether it is working", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
	});

	it("says nothing has run yet on a fresh mailbox", async () => {
		expect(await health()).toEqual({
			lastSuccessAt: null,
			lastFailureAt: null,
			lastFailureReason: null,
		});
	});

	it("records a check that answered", async () => {
		await setClaudeApiKey("sk-ant-test-key");
		await receive("A message the filter looked at");

		const after = await health();
		expect(after.lastSuccessAt).not.toBeNull();
		expect(after.lastFailureAt).toBeNull();
	});

	// The case this exists for. The stub answers 500 for this marker; the
	// message still reaches the inbox, and that is correct -- but it must not
	// be the only thing that happens.
	it("records a check that failed, and still delivers the message", async () => {
		await setClaudeApiKey("sk-ant-test-key");
		await receive("Claude API errors out TRIGGER_CLAUDE_ERROR");

		const after = await health();
		expect(after.lastFailureAt).not.toBeNull();
		expect(after.lastFailureReason).toBe("serverError");

		const inbox = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/emails?folder=inbox`,
		);
		expect(
			(await inbox.json<{ subject: string }[]>()).some((email) =>
				email.subject.includes("TRIGGER_CLAUDE_ERROR"),
			),
		).toBe(true);
	});

	/**
	 * Both are kept, rather than one "last outcome". The question worth
	 * answering is not what happened most recently but whether the check is
	 * still working -- and "it last succeeded three weeks ago" is the answer
	 * to that, which a single field would have thrown away.
	 */
	it("keeps the last success and the last failure side by side", async () => {
		await setClaudeApiKey("sk-ant-test-key");
		await receive("One that worked");
		const succeeded = await health();

		await receive("One that did not TRIGGER_CLAUDE_ERROR");
		const after = await health();

		expect(after.lastSuccessAt).toBe(succeeded.lastSuccessAt);
		expect(after.lastFailureAt).not.toBeNull();
	});

	// No key means the stage is skipped entirely, not attempted and failed.
	it("records nothing when no key is configured", async () => {
		await receive("Nobody checked this one");
		expect(await health()).toEqual({
			lastSuccessAt: null,
			lastFailureAt: null,
			lastFailureReason: null,
		});
	});

	// Mail that already failed SPF/DKIM/DMARC is spam regardless and never
	// reaches this stage, so it says nothing about the stage's health.
	it("records nothing for mail the first pass already filed", async () => {
		await setClaudeApiKey("sk-ant-test-key");
		const worker = await import("../../dev/index");
		const raw = buildRawEmail(
			{
				From: "sender@spoofed.com",
				To: mailboxId,
				Subject: "Stage one already failed",
				"Content-Type": "text/plain",
				"Authentication-Results":
					"mx.example.com; spf=fail smtp.mailfrom=spoofed.com; dkim=fail header.i=@other.com",
			},
			"Hello",
		);
		const bytes = new TextEncoder().encode(raw);
		await worker.default.email(
			{
				raw: new ReadableStream({
					start(controller) {
						controller.enqueue(bytes);
						controller.close();
					},
				}),
				rawSize: bytes.length,
				to: mailboxId,
			},
			env,
			createExecutionContext(),
		);

		expect((await health()).lastSuccessAt).toBeNull();
	});

	// Timestamps and a reason code only. The key never appears, and neither
	// does whatever the upstream API said, which is not ours to put on a
	// screen.
	it("never exposes the key or the upstream error text", async () => {
		await setClaudeApiKey("sk-ant-a-key-that-must-not-leak");
		await receive("Claude API errors out TRIGGER_CLAUDE_ERROR");

		const body = await (
			await authenticatedFetch(
				`http://local.test/api/v1/mailboxes/${mailboxId}`,
			)
		).text();
		expect(body).not.toContain("sk-ant-a-key-that-must-not-leak");
		expect(body).not.toContain("mock error");
	});
});
