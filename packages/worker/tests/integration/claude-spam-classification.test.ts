import { createExecutionContext, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	authenticatedFetch,
	createDummyMailbox,
	mailboxId,
	testAuthBeforeAll,
} from "./utils";

const PASSING_AUTH_RESULTS =
	"mx.cloudflare.net; spf=pass smtp.mailfrom=legit.com; dkim=pass header.i=@legit.com; dmarc=pass header.from=legit.com";
const FAILING_AUTH_RESULTS =
	"mx.cloudflare.net; spf=fail smtp.mailfrom=spoofed.com; dkim=fail header.i=@other.com";

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
		body: JSON.stringify({
			settings: { spamFilter: { claudeApiKey: apiKey } },
		}),
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
					"mx.cloudflare.net; spf=pass smtp.mailfrom=example.com; dkim=pass header.i=@example.com; dmarc=pass header.from=example.com",
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

		expect(await folderOf("Different domain TRIGGER_CLAUDE_SPAM")).toBe("spam");
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
						"mx.cloudflare.net; spf=pass smtp.mailfrom=legit.com; dkim=TRIGGER_CLAUDE_SPAM header.i=@legit.com; dmarc=pass header.from=legit.com",
				},
				"Hello",
			);

			await simulateReceiveEmail(rawEmail);

			expect(await folderOf("Auth verdicts reach the classifier")).toBe("spam");
		});
	});

	/**
	 * The screen shows a message's HTML part whenever it has one, and the
	 * classifier read its text part whenever it had one. These deliver the two
	 * parts with the marker in only one of them, so the folder says which part
	 * reached the classifier.
	 */
	describe("which part of a message reaches the classifier", () => {
		function multipart(subject: string, text: string, html: string): string {
			return buildRawEmail(
				{
					From: "sender@legit.com",
					To: mailboxId,
					Subject: subject,
					"MIME-Version": "1.0",
					"Content-Type": 'multipart/alternative; boundary="part"',
					"Authentication-Results": PASSING_AUTH_RESULTS,
				},
				[
					"--part",
					"Content-Type: text/plain; charset=utf-8",
					"",
					text,
					"--part",
					"Content-Type: text/html; charset=utf-8",
					"",
					html,
					"--part--",
					"",
				].join("\r\n"),
			);
		}

		it("reads the HTML part, which is what the reader is shown", async () => {
			await setClaudeApiKey("sk-ant-test-key");

			await simulateReceiveEmail(
				multipart(
					"Only the HTML part says so",
					"Thank you for your order.",
					"<p>Verify your card now TRIGGER_CLAUDE_SPAM</p>",
				),
			);

			expect(await folderOf("Only the HTML part says so")).toBe("spam");
		});

		it("reads the HTML part's character references as the reader does", async () => {
			await setClaudeApiKey("sk-ant-test-key");

			await simulateReceiveEmail(
				multipart(
					"Written as references",
					"Thank you for your order.",
					"<p>&#x54;RIGGER_CLAUDE_SPAM</p>",
				),
			);

			expect(await folderOf("Written as references")).toBe("spam");
		});

		it("still reads the text part when the HTML is only a picture", async () => {
			await setClaudeApiKey("sk-ant-test-key");

			await simulateReceiveEmail(
				multipart(
					"Picture-only HTML",
					"Cheap pills TRIGGER_CLAUDE_SPAM",
					'<table><tr><td>&nbsp;</td><td><img src="https://x.example/o.png"></td></tr></table>',
				),
			);

			expect(await folderOf("Picture-only HTML")).toBe("spam");
		});

		// The HTML part read the way a browser reads it: a `<` that opens no
		// tag is a `<` on screen, and the words after it are shown.
		it("reads the HTML part's words after a `<` that opens nothing", async () => {
			await setClaudeApiKey("sk-ant-test-key");

			await simulateReceiveEmail(
				multipart(
					"Words after a bare bracket",
					"Thank you for your order.",
					"<p>Orders under 5000 yen < ship free. TRIGGER_CLAUDE_SPAM confirm your card today.</p>",
				),
			);

			expect(await folderOf("Words after a bare bracket")).toBe("spam");
		});

		// A script that `<!--` and `<script` have escaped does not end at the
		// first `</script>`. Taken for its end, the rest was read as markup,
		// and the `<style>` after it hid the words the screen shows -- forty
		// bytes ahead of an HTML part, beside an innocent text part.
		it("reads the HTML part's words after a script the tokenizer escaped", async () => {
			await setClaudeApiKey("sk-ant-test-key");

			await simulateReceiveEmail(
				multipart(
					"After an escaped script",
					"Thank you for your order.",
					"<script><!--<script></script><style></script><p>Verify your card now TRIGGER_CLAUDE_SPAM</p><style></style>",
				),
			);

			expect(await folderOf("After an escaped script")).toBe("spam");
		});

		// A comment between two halves of a word parts nothing on screen, and
		// the reader is shown the word whole. Parted here, the classifier was
		// shown two halves of it.
		it("reads a word the HTML part splits with a comment as one word", async () => {
			await setClaudeApiKey("sk-ant-test-key");

			await simulateReceiveEmail(
				multipart(
					"A word split by a comment",
					"Thank you for your order.",
					"<p>Verify your card now TRIGGER_CL<!-- -->AUDE_SPAM</p>",
				),
			);

			expect(await folderOf("A word split by a comment")).toBe("spam");
		});

		// The other side: what the screen does not show is not read either --
		// a style, a script, the part of an escaped script past its first
		// `</script>`, a comment with no `>` in it.
		it("does not read the HTML part's styles, scripts or comments", async () => {
			await setClaudeApiKey("sk-ant-test-key");

			await simulateReceiveEmail(
				multipart(
					"Only hidden parts say so",
					"Thank you for your order.",
					"<style>/* TRIGGER_CLAUDE_SPAM */</style><script>TRIGGER_CLAUDE_SPAM</script><script><!--<script></script>TRIGGER_CLAUDE_SPAM</script><!-- TRIGGER_CLAUDE_SPAM --><p>Thank you for your order.</p>",
				),
			);

			expect(await folderOf("Only hidden parts say so")).toBe("inbox");
		});

		// The other side: two clean parts are still let through.
		it("keeps a message whose parts are both clean in the inbox", async () => {
			await setClaudeApiKey("sk-ant-test-key");

			await simulateReceiveEmail(
				multipart(
					"Both parts clean",
					"Thank you for your order.",
					"<p>Thank you for your order.</p>",
				),
			);

			expect(await folderOf("Both parts clean")).toBe("inbox");
		});

		it("reads a text-only message's words after padding that takes no room", async () => {
			await setClaudeApiKey("sk-ant-test-key");

			await simulateReceiveEmail(
				buildRawEmail(
					{
						From: "sender@legit.com",
						To: mailboxId,
						Subject: "Padded plain text",
						"Content-Type": "text/plain; charset=utf-8",
						"Authentication-Results": PASSING_AUTH_RESULTS,
					},
					`${"\u200b".repeat(4500)}${"\r\n".repeat(4500)}Verify your card now TRIGGER_CLAUDE_SPAM\r\n`,
				),
			);

			expect(await folderOf("Padded plain text")).toBe("spam");
		});
	});
});
