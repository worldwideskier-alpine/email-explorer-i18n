import { env, createExecutionContext } from "cloudflare:test";
import { describe, expect, it, beforeEach } from "vitest";
import { authenticatedFetch, mailboxId, testAuthBeforeAll } from "./utils";

function buildRawEmail(headers: Record<string, string>, body: string): string {
	let raw = "";
	for (const [key, value] of Object.entries(headers)) {
		raw += `${key}: ${value}\r\n`;
	}
	raw += `\r\n${body}`;
	return raw;
}

async function simulateReceiveEmail(rawEmailStr: string) {
	const worker = await import("../../dev/index");
	const rawBytes = new TextEncoder().encode(rawEmailStr);
	const stream = new ReadableStream({
		start(controller) {
			controller.enqueue(rawBytes);
			controller.close();
		},
	});

	await worker.default.email(
		{ raw: stream, rawSize: rawBytes.length },
		env,
		createExecutionContext(),
	);
}

describe("Original message source", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
	});

	it("returns the raw source for an email imported via the admin endpoint", async () => {
		const rawEmail = buildRawEmail(
			{
				From: "sender@example.com",
				To: mailboxId,
				Subject: "Imported source test",
				"Content-Type": "text/plain",
				"X-Custom-Header": "some-value",
			},
			"Body text",
		);
		const rawBase64 = btoa(rawEmail);

		const importResponse = await authenticatedFetch(
			`http://local.test/api/v1/admin/mailboxes/${mailboxId}/import`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ rawEmailBase64: rawBase64 }),
			},
		);
		expect(importResponse.status).toBe(201);
		const { id } = await importResponse.json<any>();

		const sourceResponse = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/emails/${id}/source`,
		);
		expect(sourceResponse.status).toBe(200);
		expect(sourceResponse.headers.get("Content-Type")).toContain("text/plain");
		const sourceText = await sourceResponse.text();
		expect(sourceText).toContain("X-Custom-Header: some-value");
		expect(sourceText).toContain("Body text");
	});

	it("returns the raw source for a real inbound email", async () => {
		await authenticatedFetch("http://local.test/api/v1/debug/create-mailbox", { method: "POST" });

		const rawEmail = buildRawEmail(
			{
				From: "sender@example.com",
				To: mailboxId,
				Subject: "Inbound source test",
				"Content-Type": "text/plain",
				"Authentication-Results": "mx.example.com; spf=pass; dkim=pass; dmarc=pass",
			},
			"Inbound body",
		);

		await simulateReceiveEmail(rawEmail);

		const listResponse = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/emails?folder=inbox`,
		);
		const emails = await listResponse.json<any[]>();
		const received = emails.find((e: any) => e.subject === "Inbound source test");
		expect(received).toBeDefined();

		const sourceResponse = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/emails/${received.id}/source`,
		);
		expect(sourceResponse.status).toBe(200);
		const sourceText = await sourceResponse.text();
		expect(sourceText).toContain("Authentication-Results:");
		expect(sourceText).toContain("Inbound body");
	});

	it("returns 404 when no raw source was stored (e.g. a locally composed reply)", async () => {
		await authenticatedFetch("http://local.test/api/v1/debug/create-mailbox", { method: "POST" });

		const sourceResponse = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/emails/nonexistent-id/source`,
		);
		expect(sourceResponse.status).toBe(404);
	});
});
