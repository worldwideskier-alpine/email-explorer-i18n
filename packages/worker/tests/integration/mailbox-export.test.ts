import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	authenticatedFetch,
	createDummyMailbox,
	mailboxId,
	testAuthBeforeAll,
} from "./utils";

const RAW_SUBJECT = "請求書送付のご案内";

function rawEmail(body: string): string {
	return Buffer.from(
		[
			"From: sender@example.org",
			`To: ${mailboxId}`,
			`Subject: =?UTF-8?B?${Buffer.from(RAW_SUBJECT, "utf8").toString("base64")}?=`,
			"MIME-Version: 1.0",
			'Content-Type: text/plain; charset="utf-8"',
			"",
			body,
			"",
		].join("\r\n"),
		"utf8",
	).toString("base64");
}

async function importEmail(body: string): Promise<string> {
	const res = await authenticatedFetch(
		`http://local.test/api/v1/admin/mailboxes/${mailboxId}/import`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ folder: "inbox", rawEmailBase64: rawEmail(body) }),
		},
	);
	expect(res.status).toBe(201);
	return (await res.json<{ id: string }>()).id;
}

const exportMbox = async (): Promise<Response> =>
	authenticatedFetch(`http://local.test/api/v1/mailboxes/${mailboxId}/export`);

describe("Exporting a mailbox as mbox", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
	});

	it("names the download after the mailbox and the day", async () => {
		const res = await exportMbox();
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toContain("application/mbox");
		expect(res.headers.get("Content-Disposition")).toMatch(
			new RegExp(`attachment; filename="${mailboxId}-\\d{4}-\\d{2}-\\d{2}\\.mbox"`),
		);
	});

	it("is empty, not broken, for a mailbox with no mail", async () => {
		const res = await exportMbox();
		expect(await res.text()).toBe("");
	});

	// Received mail has a stored raw copy, and writing that back verbatim is
	// what makes the archive a faithful backup rather than a rendering of it.
	it("writes received mail out byte for byte", async () => {
		await importEmail("本文です");
		const text = await (await exportMbox()).text();

		expect(text).toContain("From sender@example.org ");
		expect(text).toContain("X-Email-Explorer-Folder: inbox");
		expect(text).toContain("From: sender@example.org");
		// The subject stays in its original encoded form, not re-encoded.
		expect(text).toContain(
			`=?UTF-8?B?${Buffer.from(RAW_SUBJECT, "utf8").toString("base64")}?=`,
		);
		expect(text).toContain("本文です");
	});

	// Without this the archive splits in the wrong place and a reader sees one
	// message as two.
	it("quotes body lines that look like a message separator", async () => {
		await importEmail("From here on it continues\r\n>From already quoted");
		const text = await (await exportMbox()).text();

		expect(text).toContain(">From here on it continues");
		expect(text).toContain(">>From already quoted");
	});

	it("puts one separator per message", async () => {
		await importEmail("first");
		await importEmail("second");
		await importEmail("third");
		const text = await (await exportMbox()).text();

		const separators = text.match(/^From sender@example\.org /gm) ?? [];
		expect(separators).toHaveLength(3);
	});

	it("refuses a mailbox that does not exist", async () => {
		const res = await authenticatedFetch(
			"http://local.test/api/v1/mailboxes/nobody@example.com/export",
		);
		expect(res.status).toBe(404);
	});

	it("needs a session", async () => {
		const res = await SELF.fetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/export`,
		);
		expect(res.status).toBe(401);
	});
});
