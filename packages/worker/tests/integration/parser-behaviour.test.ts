import { createExecutionContext, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { classifyByAuthResults, summarizeAuthResults } from "../../src/spam-filter";
import {
	authenticatedFetch,
	createDummyMailbox,
	mailboxId,
	testAuthBeforeAll,
} from "./utils";

/**
 * What the MIME parser hands us, for the shapes where its behaviour has
 * actually changed under us.
 *
 * postal-mime 3.0.0 changed three things: header values keep the whitespace
 * that folding introduced instead of collapsing it, a duplicated single-value
 * header such as From or Subject resolves to the first occurrence rather than
 * the last, and repeated To/Cc headers come back in document order rather than
 * reversed.
 *
 * The tests that existed before the upgrade all passed, and would have passed
 * even if the first change had broken spam filtering outright -- because they
 * fed the filter a single-line Authentication-Results header, and a real one
 * is always folded. These use the folded form.
 */

function buildRawEmail(lines: string[]): string {
	return lines.join("\r\n");
}

async function receive(raw: string) {
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

async function inbox() {
	const res = await authenticatedFetch(
		`http://local.test/api/v1/mailboxes/${mailboxId}/emails?folder=inbox`,
	);
	return res.json<
		{ id: string; subject: string; sender: string; recipient: string; cc: string }[]
	>();
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

/**
 * An Authentication-Results header as a relay actually writes one: too long
 * for a line, so folded, with the continuation indented. Under 3.0.0 that
 * indentation survives into the header value.
 */
const FOLDED_FAILING_AUTH = [
	"Authentication-Results: mx.cloudflare.net;",
	"\tdkim=fail (verification failed) header.i=@spoofed.com;",
	"\tdmarc=none header.from=spoofed.com policy.dmarc=none;",
	"\tspf=none (no SPF records found for postmaster@host.invalid)",
	"\t smtp.helo=host.invalid;",
	"\tspf=fail (domain of no-reply@spoofed.com does not designate 203.0.113.9)",
	"\t smtp.mailfrom=no-reply@spoofed.com;",
	"\tarc=none smtp.remote-ip=203.0.113.9",
].join("\r\n");

const FOLDED_PASSING_AUTH = [
	"Authentication-Results: mx.cloudflare.net;",
	"\tdkim=pass header.i=@legit.com;",
	"\tdmarc=pass header.from=legit.com policy.dmarc=reject;",
	"\tspf=pass (domain of sender@legit.com designates 203.0.113.1)",
	"\t smtp.mailfrom=sender@legit.com;",
	"\tarc=none",
].join("\r\n");

describe("a folded Authentication-Results header", () => {
	// The tab and the run of spaces that folding leaves behind sit between the
	// very tokens the verdicts are read out of.
	const headerOf = (raw: string) => [
		{
			key: "authentication-results",
			originalKey: "Authentication-Results",
			value: raw
				.replace(/^Authentication-Results: /, "")
				.replace(/\r\n/g, ""),
		},
	];

	it("still yields the verdicts when the value carries folding whitespace", () => {
		expect(summarizeAuthResults(headerOf(FOLDED_FAILING_AUTH))).toEqual({
			spf: "fail",
			dkim: "fail",
			dmarc: "none",
			dmarcPolicy: "none",
		});
	});

	it("still reads SPF from the envelope sender, not the HELO name", () => {
		// Both spf= results are in the folded value; taking the first would
		// read "none" and let a hard failure through.
		expect(summarizeAuthResults(headerOf(FOLDED_FAILING_AUTH)).spf).toBe("fail");
	});

	it("still files the message the folded header condemns", () => {
		expect(classifyByAuthResults(headerOf(FOLDED_FAILING_AUTH))).toBe("spam");
	});

	it("still keeps the message the folded header clears", () => {
		expect(classifyByAuthResults(headerOf(FOLDED_PASSING_AUTH))).toBe("inbox");
	});
});

describe("what the parser hands the ingest path", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
	});

	it("files a message whose folded header condemns it as spam", async () => {
		await receive(
			buildRawEmail([
				"From: no-reply@spoofed.com",
				`To: ${mailboxId}`,
				"Subject: Folded and failing",
				FOLDED_FAILING_AUTH,
				"Content-Type: text/plain; charset=UTF-8",
				"",
				"body",
			]),
		);
		expect(await folderOf("Folded and failing")).toBe("spam");
	});

	/**
	 * A second From header is a spoofing move: pick whichever one the reader
	 * does not. 2.6.1 resolved the last, so the forged one won; 3.0.0 resolves
	 * the first, which is what the relay authenticated against.
	 */
	it("stores the first From, not a second one added after it", async () => {
		await receive(
			buildRawEmail([
				"From: real@legit.com",
				"From: spoofed@attacker.invalid",
				`To: ${mailboxId}`,
				"Subject: Two senders",
				FOLDED_PASSING_AUTH,
				"Content-Type: text/plain; charset=UTF-8",
				"",
				"body",
			]),
		);
		const stored = (await inbox()).find((e) => e.subject === "Two senders");
		expect(stored?.sender).toBe("real@legit.com");
	});

	it("stores the first Subject, not a second one added after it", async () => {
		await receive(
			buildRawEmail([
				"From: sender@legit.com",
				`To: ${mailboxId}`,
				"Subject: The real subject",
				"Subject: The replacement",
				FOLDED_PASSING_AUTH,
				"Content-Type: text/plain; charset=UTF-8",
				"",
				"body",
			]),
		);
		const subjects = (await inbox()).map((e) => e.subject);
		expect(subjects).toContain("The real subject");
		expect(subjects).not.toContain("The replacement");
	});

	/**
	 * Repeated To/Cc headers used to come back reversed, so the stored list --
	 * which is what "reply all" is built from -- was in the opposite order to
	 * the message. Nothing was lost, but the order shown was wrong.
	 */
	it("keeps repeated recipient headers in the order they were sent", async () => {
		await receive(
			buildRawEmail([
				"From: sender@legit.com",
				`To: ${mailboxId}`,
				"To: second@example.com",
				"Cc: cc-one@example.com",
				"Cc: cc-two@example.com",
				"Subject: Repeated recipient headers",
				FOLDED_PASSING_AUTH,
				"Content-Type: text/plain; charset=UTF-8",
				"",
				"body",
			]),
		);
		const listed = (await inbox()).find(
			(e) => e.subject === "Repeated recipient headers",
		);
		expect(listed?.recipient).toBe(`${mailboxId}, second@example.com`);

		// Cc is not in the list projection -- the list does not show it -- so
		// the stored value has to come from the message itself.
		const full = await (
			await authenticatedFetch(
				`http://local.test/api/v1/mailboxes/${mailboxId}/emails/${listed?.id}`,
			)
		).json<{ cc: string }>();
		expect(full.cc).toBe("cc-one@example.com, cc-two@example.com");
	});

	// The shapes the diff against 2.6.1 showed unchanged, kept so a later
	// upgrade cannot move them quietly: an encoded-word display name, a
	// full-width space in the body, and a folded References chain.
	it("still decodes an encoded-word display name and keeps the body intact", async () => {
		const encoded = btoa(
			String.fromCharCode(
				...new TextEncoder().encode("セゾンカード"),
			),
		);
		await receive(
			buildRawEmail([
				`From: =?UTF-8?B?${encoded}?= <mail.saisoncard@mfdpfdyn.info>`,
				`To: ${mailboxId}`,
				"Subject: Encoded name",
				"References: <a@example.com>",
				"\t<b@example.com>",
				FOLDED_PASSING_AUTH,
				"Content-Type: text/plain; charset=UTF-8",
				"",
				"魚田　様",
			]),
		);
		const stored = (await inbox()).find((e) => e.subject === "Encoded name");
		expect(stored?.sender).toBe("mail.saisoncard@mfdpfdyn.info");

		const full = await (
			await authenticatedFetch(
				`http://local.test/api/v1/mailboxes/${mailboxId}/emails/${stored?.id}`,
			)
		).json<{ body: string }>();
		// The ideographic space is content, and the <pre> wrapper is what the
		// reply composer later opens back out.
		expect(full.body).toContain("魚田　様");
	});
});
