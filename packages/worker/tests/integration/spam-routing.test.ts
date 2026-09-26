import { createExecutionContext, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	authenticatedFetch,
	createDummyMailbox,
	mailboxId,
	testAuthBeforeAll,
} from "./utils";

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

describe("Inbound spam routing (SPF/DKIM/DMARC)", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
	});

	it("keeps a fully-authenticated email in the inbox", async () => {
		const rawEmail = buildRawEmail(
			{
				From: "sender@legit.com",
				To: mailboxId,
				Subject: "Legit passing email",
				"Content-Type": "text/plain",
				"Authentication-Results":
					"mx.cloudflare.net; spf=pass smtp.mailfrom=legit.com; dkim=pass header.i=@legit.com; dmarc=pass header.from=legit.com",
			},
			"Hello",
		);

		await simulateReceiveEmail(rawEmail);

		expect(await folderOf("Legit passing email")).toBe("inbox");
	});

	it("routes an email with a dmarc fail to spam", async () => {
		const rawEmail = buildRawEmail(
			{
				From: "sender@spoofed.com",
				To: mailboxId,
				Subject: "Dmarc fail email",
				"Content-Type": "text/plain",
				"Authentication-Results":
					"mx.cloudflare.net; spf=pass smtp.mailfrom=spoofed.com; dkim=pass header.i=@other.com; dmarc=fail header.from=spoofed.com",
			},
			"Hello",
		);

		await simulateReceiveEmail(rawEmail);

		expect(await folderOf("Dmarc fail email")).toBe("spam");
	});

	it("routes an email with both spf and dkim failing to spam", async () => {
		const rawEmail = buildRawEmail(
			{
				From: "sender@spoofed.com",
				To: mailboxId,
				Subject: "Spf and dkim fail email",
				"Content-Type": "text/plain",
				"Authentication-Results":
					"mx.cloudflare.net; spf=fail smtp.mailfrom=spoofed.com; dkim=fail header.i=@other.com",
			},
			"Hello",
		);

		await simulateReceiveEmail(rawEmail);

		expect(await folderOf("Spf and dkim fail email")).toBe("spam");
	});

	/**
	 * Header order as Cloudflare delivers it, from a live message: the ARC
	 * copy (`i=1; mx.cloudflare.net;`) sits above the relay's own header,
	 * folded across lines. Read through the real parser, the relay's header
	 * is the one that decides.
	 */
	it("reads the relay's own header below its ARC copy", async () => {
		const raw = [
			"Received: from host.invalid by cloudflare-email.net",
			"ARC-Authentication-Results: i=1; mx.cloudflare.net;",
			"\tdkim=pass header.d=spoofed.com; dmarc=pass header.from=spoofed.com",
			"Authentication-Results: mx.cloudflare.net;",
			"\tdkim=none;",
			"\tdmarc=fail header.from=spoofed.com policy.dmarc=reject;",
			"\tspf=fail (mx.cloudflare.net: domain of x@spoofed.com does not designate 203.0.113.9)",
			"\t smtp.mailfrom=x@spoofed.com",
			"From: sender@spoofed.com",
			`To: ${mailboxId}`,
			"Subject: Relay header below ARC",
			"Content-Type: text/plain",
			"",
			"Hello",
		].join("\r\n");

		await simulateReceiveEmail(raw);

		expect(await folderOf("Relay header below ARC")).toBe("spam");
	});

	/** Without the relay's header, the sender's is not read in its place. */
	it("reads nothing from a header another name wrote", async () => {
		const rawEmail = buildRawEmail(
			{
				From: "sender@spoofed.com",
				To: mailboxId,
				Subject: "Header under another name",
				"Content-Type": "text/plain",
				"Authentication-Results":
					"mx.other.example; spf=fail smtp.mailfrom=spoofed.com; dmarc=fail header.from=spoofed.com",
			},
			"Hello",
		);

		await simulateReceiveEmail(rawEmail);

		expect(await folderOf("Header under another name")).toBe("inbox");
	});

	it("keeps an email with no Authentication-Results header in the inbox (fail-open)", async () => {
		const rawEmail = buildRawEmail(
			{
				From: "sender@unknown.com",
				To: mailboxId,
				Subject: "No auth headers email",
				"Content-Type": "text/plain",
			},
			"Hello",
		);

		await simulateReceiveEmail(rawEmail);

		expect(await folderOf("No auth headers email")).toBe("inbox");
	});
});
