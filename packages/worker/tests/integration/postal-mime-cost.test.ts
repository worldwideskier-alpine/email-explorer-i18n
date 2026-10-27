import { createExecutionContext, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	authenticatedFetch,
	createDummyMailbox,
	mailboxId,
	testAuthBeforeAll,
} from "./utils";

/**
 * GHSA-f2hq-32vh-53cc (high): postal-mime before 4.0.8 joined adjacent base64
 * encoded words by testing the whole text joined so far, so the cost grew
 * with the square of their number. The email() handler parses every message
 * to an existing mailbox before anything else, so anyone who knows an
 * address could send one: 120,000 short words fit inside the 2 MiB header
 * budget, and on 4.0.0 this message took 11.6 s of the invocation's CPU
 * where 4.0.8 took 0.12 s and 4.1.4 0.19 s (measured through this handler in
 * workerd). Five seconds leaves room either side for a slow runner.
 */
const WORDS = 120_000;

function subjectOf(words: number): string {
	const line = Array.from({ length: 50 }, () => "=?utf-8?B?QUJD?=").join(" ");
	return Array.from({ length: words / 50 }, () => line).join("\r\n ");
}

describe("a subject of many joinable base64 encoded words", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
	});

	it("is received in linear time", { timeout: 120_000 }, async () => {
		const raw = [
			"From: sender@example.net",
			`To: ${mailboxId}`,
			`Subject: ${subjectOf(WORDS)}`,
			"Content-Type: text/plain",
			"",
			"body",
		].join("\r\n");
		const bytes = new TextEncoder().encode(raw);
		const worker = await import("../../dev/index");
		const started = Date.now();
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
		const took = Date.now() - started;
		const listed = await (
			await authenticatedFetch(
				`http://local.test/api/v1/mailboxes/${mailboxId}/emails?folder=inbox`,
			)
		).json<{ subject: string }[]>();
		expect(listed.some((e) => e.subject.startsWith("ABCABC"))).toBe(true);
		expect(took).toBeLessThan(5_000);
	});
});
