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

async function folderOf(subject: string): Promise<string | undefined> {
	for (const folder of ["inbox", "spam"]) {
		const res = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/emails?folder=${folder}`,
		);
		const emails = await res.json<{ subject: string }[]>();
		if (emails.some((email) => email.subject === subject)) return folder;
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
				lastFailureDetail: string | null;
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
			lastFailureDetail: null,
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
			lastFailureDetail: null,
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

	/**
	 * Saving anything on the settings screen must not blank the health line.
	 *
	 * The browser replaces its whole copy of the mailbox with whatever a save
	 * returns, and the save used to return everything except this. So saving
	 * the key -- which is exactly when someone is looking at this line -- took
	 * the screen from "last failed at 21:34" to "never run", while the record
	 * itself had not been touched at all. The two responses describe the same
	 * thing and the client treats them as interchangeable, so they have to
	 * carry the same fields.
	 */
	it("still reports the record in the response to a save", async () => {
		await setClaudeApiKey("sk-ant-test-key");
		await receive("One that worked");
		await receive("One that did not TRIGGER_CLAUDE_401");
		const recorded = await health();
		expect(recorded.lastSuccessAt).not.toBeNull();
		expect(recorded.lastFailureAt).not.toBeNull();

		// Saving the key: the case that made this visible.
		const saved = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}`,
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					settings: { spamFilter: { claudeApiKey: "sk-ant-test-key" } },
				}),
			},
		);
		expect(await saved.json<{ spamCheck: unknown }>()).toMatchObject({
			spamCheck: recorded,
		});

		// And saving something with nothing to do with the key.
		const other = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}`,
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					settings: { signature: { enabled: true, text: "hi" } },
				}),
			},
		);
		expect(await other.json<{ spamCheck: unknown }>()).toMatchObject({
			spamCheck: recorded,
		});
	});

	/**
	 * The two refusals, which used to be recorded as one reason.
	 *
	 * They are not one problem. 401 is the key: it is wrong, or it was deleted
	 * upstream, and entering the right one fixes it. 403 is not the key, and
	 * entering a correct key again and again fixes nothing -- so a screen that
	 * says "check your key" to both sends half its readers the wrong way.
	 */
	it("tells a rejected key from a key that is refused permission", async () => {
		await setClaudeApiKey("sk-ant-test-key");

		await receive("Wrong key TRIGGER_CLAUDE_401");
		const rejected = await health();
		expect(rejected.lastFailureReason).toBe("unauthorized");
		expect(rejected.lastFailureDetail).toBe("401 authentication_error");

		await receive("Not permitted TRIGGER_CLAUDE_403");
		const refused = await health();
		expect(refused.lastFailureReason).toBe("forbidden");
		expect(refused.lastFailureDetail).toBe("403 permission_error");
	});

	/**
	 * And the third case, which shares its status with the second and has
	 * nothing else in common: the request was turned away before the API saw
	 * it. The API answers in JSON and names its own reason; whatever stands in
	 * front of it answers with a page. The absence of that JSON is the finding,
	 * and the page itself is never quoted.
	 */
	it("says when a refusal did not come from the API at all", async () => {
		await setClaudeApiKey("sk-ant-test-key");
		await receive("Turned away TRIGGER_CLAUDE_EDGE_403");

		const after = await health();
		expect(after.lastFailureReason).toBe("forbidden");
		expect(after.lastFailureDetail).toBe("403 (no API error body)");
		expect(after.lastFailureDetail).not.toContain("blocked");
		// Still delivered: this stage fails open, whatever refused it.
		expect(await folderOf("Turned away TRIGGER_CLAUDE_EDGE_403")).toBe("inbox");
	});

	/**
	 * A reply that carries a verdict but not on its own. The old comparison
	 * was against the whole reply, so decoration was enough to lose the
	 * verdict entirely and file the message as unclassifiable.
	 */
	it("reads a verdict that arrives with decoration around it", async () => {
		await setClaudeApiKey("sk-ant-test-key");
		await receive("Decorated answer TRIGGER_CLAUDE_DECORATED");

		const after = await health();
		expect(after.lastSuccessAt).not.toBeNull();
		expect(after.lastFailureAt).toBeNull();
	});

	/**
	 * And a reply that does not begin with a verdict. This one must still be
	 * a failure -- reading on to the SPAM at the end of the sentence would
	 * file a real message as spam -- but the reply has to be kept, because it
	 * is the only thing that says why.
	 */
	it("keeps the reply it could not read", async () => {
		await setClaudeApiKey("sk-ant-test-key");
		await receive("Explained instead of answered TRIGGER_CLAUDE_PREAMBLE");

		const after = await health();
		expect(after.lastFailureReason).toBe("malformed");
		expect(after.lastFailureDetail).toBe(
			"Based on the sender domain, this is SPAM",
		);
		expect(
			await folderOf("Explained instead of answered TRIGGER_CLAUDE_PREAMBLE"),
		).toBe("inbox");
	});

	// Nothing to quote: the model returned no content at all. The API's own
	// reason for stopping stands in, which is what distinguishes "it declined"
	// from "it rambled".
	it("records why the model stopped when it said nothing", async () => {
		await setClaudeApiKey("sk-ant-test-key");
		await receive("Declined TRIGGER_CLAUDE_REFUSAL");

		const after = await health();
		expect(after.lastFailureReason).toBe("malformed");
		expect(after.lastFailureDetail).toBe("stop_reason=refusal");
	});

	/**
	 * The mechanism that stops a preamble being produced in the first place:
	 * the assistant's turn is started for us, so the model continues it rather
	 * than opening a reply of its own. The stub answers with the shape of the
	 * request because nothing else in the suite can see what went out.
	 */
	it("sends a prefilled assistant turn and room to answer", async () => {
		await setClaudeApiKey("sk-ant-test-key");
		await receive("What went out TRIGGER_CLAUDE_ECHO_SHAPE");

		expect((await health()).lastFailureDetail).toBe(
			"assistant-turn=yes max_tokens=16",
		);
	});

	// A later failure of a different kind must not leave the previous reply
	// on screen beside it, saying something about a failure that is over.
	it("drops the kept reply when the next failure is a different one", async () => {
		await setClaudeApiKey("sk-ant-test-key");
		await receive("First TRIGGER_CLAUDE_PREAMBLE");
		expect((await health()).lastFailureDetail).toBe(
			"Based on the sender domain, this is SPAM",
		);

		await receive("Then TRIGGER_CLAUDE_ERROR");
		const after = await health();
		expect(after.lastFailureReason).toBe("serverError");
		// The new failure's own line, and nothing of the old one.
		expect(after.lastFailureDetail).toBe("500 (no API error body)");
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
