import { createExecutionContext, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	authenticatedFetch,
	createDummyMailbox,
	mailboxId,
	testAuthBeforeAll,
} from "./utils";

/**
 * A busy second at Anthropic must not cost a classification.
 *
 * `529 overloaded_error` means the API is busy right now; it clears on its own,
 * usually within seconds. There was no retry, so one of them ended the check --
 * and the check fails open, which means the message went into the inbox
 * unclassified with nothing to look at it again. On a live mailbox that is a
 * spam message delivered, silently, because of a second of weather upstream.
 *
 * The stub (see vitest.config.mts) answers 529 for the first n attempts against
 * a tag and then answers properly, so a verdict arriving at all is proof that
 * something asked again. Each test uses its own tag: the count lives for the
 * life of the worker process.
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

async function deliver(subject: string) {
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
	const worker = await import("../../dev/index");
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
		if (emails.some((e) => e.subject === subject)) return folder;
	}
	return undefined;
}

async function health(): Promise<{
	lastFailureReason: string | null;
	lastFailureDetail?: string | null;
	lastSuccessAt: string | null;
}> {
	const res = await authenticatedFetch(
		`http://local.test/api/v1/mailboxes/${mailboxId}`,
	);
	const body = await res.json<{
		spamCheck?: {
			lastFailureReason: string | null;
			lastFailureDetail?: string | null;
			lastSuccessAt: string | null;
		};
	}>();
	return body.spamCheck ?? { lastFailureReason: null, lastSuccessAt: null };
}

describe("an overloaded API", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
		await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}`,
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					settings: { spamFilter: { claudeApiKey: "sk-ant-test-key" } },
				}),
			},
		);
	});

	// The failure that has actually been happening, and the whole point: one
	// 529, then the answer. Without a retry this lands in the inbox.
	it("does not cost the classification when it clears on the second ask", async () => {
		const subject = "Overloaded once TRIGGER_CLAUDE_OVERLOAD_ONCE_1";
		await deliver(subject);

		expect(await folderOf(subject)).toBe("spam");
	});

	// Two in a row, which is the last attempt of three. Still classified.
	it("keeps asking to the end of its attempts", async () => {
		const subject = "Overloaded twice TRIGGER_CLAUDE_OVERLOAD_TWICE_2";
		await deliver(subject);

		expect(await folderOf(subject)).toBe("spam");
	});

	/**
	 * And it does not retry for ever. Past the attempt limit the check fails
	 * open exactly as before -- the message reaches the inbox rather than being
	 * held or lost, which is the direction this whole stage errs in -- and the
	 * settings screen is told why.
	 */
	it("gives up after its attempts and says so, still failing open", async () => {
		const subject = "Overloaded always TRIGGER_CLAUDE_OVERLOAD_ALWAYS_99";
		await deliver(subject);

		expect(await folderOf(subject)).toBe("inbox");
		expect((await health()).lastFailureReason).toBe("serverError");
	});

	/**
	 * The other transient failure, and the one this retry originally missed.
	 *
	 * `403 forbidden` is a refusal the Messages API did not send -- the call
	 * never reached it -- and on the live mailbox it has cleared on its own
	 * every time. Deciding retryability by status alone gave it a single
	 * attempt, because 403 normally means "about this request".
	 */
	it("retries a 403 the API did not send, and classifies", async () => {
		const subject = "Blocked once TRIGGER_CLAUDE_BLOCKED_ONCE_1";
		await deliver(subject);

		expect(await folderOf(subject)).toBe("spam");
	});

	/**
	 * And when it does not clear, the record finally says who refused. Every
	 * occurrence so far has recorded `403 forbidden` and nothing else, which
	 * cannot distinguish Anthropic's edge from a proxy in front of it.
	 */
	it("records who refused when it does not clear", async () => {
		const subject = "Blocked always TRIGGER_CLAUDE_BLOCKED_ALWAYS_99";
		await deliver(subject);

		expect(await folderOf(subject)).toBe("inbox");
		const state = await health();
		expect(state.lastFailureReason).toBe("blocked");
		expect(state.lastFailureDetail).toContain("403 forbidden");
		expect(state.lastFailureDetail).toContain("server=cloudflare");
		expect(state.lastFailureDetail).toContain("cf-ray=");
	});

	/**
	 * A key that is not valid is not valid the second time either. Retrying it
	 * would spend the budget to reach the same answer and delay the message
	 * doing it, so the refusals are answered once.
	 */
	it("does not retry a refusal about the key itself", async () => {
		const subject = "Bad key TRIGGER_CLAUDE_401";
		await deliver(subject);

		expect(await folderOf(subject)).toBe("inbox");
		expect((await health()).lastFailureReason).toBe("unauthorized");
	});
});
