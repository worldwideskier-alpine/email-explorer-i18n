import { createExecutionContext, env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	authenticatedFetch,
	createDummyMailbox,
	mailboxId,
	sessionToken,
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

async function importEmail(
	body: string,
	extra: Record<string, unknown> = {},
): Promise<string> {
	const res = await authenticatedFetch(
		`http://local.test/api/v1/admin/mailboxes/${mailboxId}/import`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				folder: "inbox",
				rawEmailBase64: rawEmail(body),
				...extra,
			}),
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
			new RegExp(
				`attachment; filename="${mailboxId}-\\d{4}-\\d{2}-\\d{2}\\.mbox"`,
			),
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
		expect(text).toContain("X-Email-Explorer-Folder: Inbox");
		// Our block ends with a marker and the message follows it, so a
		// message that begins with a line of the same shape keeps it.
		expect(text).toMatch(
			/X-Email-Explorer-Date: [^\r\n]+\r\nX-Email-Explorer-End: 1\r\nFrom: sender@example\.org/,
		);
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

	// A backup that says every message was an unread message in the inbox is
	// not a backup of this mailbox. The export read the row's `folder`, but the
	// column is `folder_id`, so it wrote "inbox" for all of them and no test
	// noticed -- every case here only ever imported into the inbox.
	it("records the folder each message actually sat in", async () => {
		await importEmail("in the inbox");
		await importEmail("already sent", { folder: "sent" });
		const text = await (await exportMbox()).text();

		expect(text).toContain("X-Email-Explorer-Folder: Inbox");
		expect(text).toContain("X-Email-Explorer-Folder: Sent");
	});

	it("records read and starred", async () => {
		await importEmail("seen and kept", { read: true, starred: true });
		await importEmail("neither");
		const text = await (await exportMbox()).text();

		expect(text).toContain("X-Email-Explorer-Read: 1");
		expect(text).toContain("X-Email-Explorer-Starred: 1");
		expect(text).toContain("X-Email-Explorer-Read: 0");
		expect(text).toContain("X-Email-Explorer-Starred: 0");
	});

	it("records the id and date, so a restore can put them back", async () => {
		const id = await importEmail("dated", {
			date: "2026-08-01T10:00:00.000Z",
		});
		const text = await (await exportMbox()).text();

		expect(text).toContain(`X-Email-Explorer-Id: ${id}`);
		expect(text).toContain("X-Email-Explorer-Date: 2026-08-01T10:00:00.000Z");
	});

	// The reader stops at the first line that is not one of ours, so a message
	// header appearing among them would hide the rest. Keep them contiguous and
	// ahead of the message.
	it("writes its own headers as one block before the message", async () => {
		await importEmail("body", { folder: "sent", read: true });
		const text = await (await exportMbox()).text();

		const lines = text.split("\r\n");
		const start = lines.findIndex((line) => line.startsWith("From "));
		const ours = lines
			.slice(start + 1)
			.findIndex((line) => !line.startsWith("X-Email-Explorer-"));

		// Id, Folder, Read, Starred, Date, and the End that closes them.
		expect(ours).toBe(6);
		expect(lines[start + ours]).toBe("X-Email-Explorer-End: 1");
		expect(lines[start + ours + 1]).toBe("From: sender@example.org");
	});

	it("refuses a mailbox that is not this person's", async () => {
		const res = await authenticatedFetch(
			"http://local.test/api/v1/mailboxes/nobody@example.com/export",
		);
		// Refused for not being this person's, which comes before the
		// question of whether it exists at all.
		expect(res.status).toBe(403);
	});

	it("needs a session", async () => {
		const res = await SELF.fetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/export`,
		);
		expect(res.status).toBe(401);
	});
});

/**
 * Mail deleted while the download is under way.
 *
 * The ids are listed first and each message is read as the download reaches
 * it. One deleted in between came back as nothing, and the stream's pull
 * returned without handing over a chunk -- which a stream is not obliged to
 * follow with another pull, so the download could stop there, open, for good.
 */
describe("an export while mail is being deleted", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
	});

	it("finishes, with the mail that is still there", async () => {
		for (const n of [1, 2, 3, 4, 5, 6]) await importEmail(`message ${n}`);
		const real = env.MAILBOX;
		const ours = real.idFromName(mailboxId);
		const listed: string[] = await real.get(ours).listEmailIdsByDate();
		// Deleted after the listing, before the download reached them: every
		// message but the first and the last, several in a row.
		const gone = new Set(listed.slice(1, -1));

		const MAILBOX = {
			idFromName: (name: string) => real.idFromName(name),
			get: (doId: DurableObjectId) => {
				const stub = real.get(doId);
				if (!doId.equals(ours)) return stub;
				// Only what the route asks of this mailbox: an RPC stub cannot
				// be wrapped in a Proxy, since every property is a remote call.
				return {
					listEmailIdsByDate: () => stub.listEmailIdsByDate(),
					getFolders: () => stub.getFolders(),
					getEmail: async (id: string) =>
						gone.has(id) ? null : stub.getEmail(id),
				};
			},
		};
		const worker = await import("../../dev/index");
		const res = await worker.default.fetch(
			new Request(`http://local.test/api/v1/mailboxes/${mailboxId}/export`, {
				headers: { Authorization: `Bearer ${sessionToken}` },
			}),
			{ ...env, MAILBOX } as never,
			createExecutionContext(),
		);
		expect(res.status).toBe(200);

		const outcome = await Promise.race([
			res.text(),
			new Promise<string>((resolve) =>
				setTimeout(() => resolve("still open"), 3000),
			),
		]);
		expect(outcome).not.toBe("still open");
		expect(outcome.match(/^From /gm)).toHaveLength(2);
		for (const id of [listed[0], listed[listed.length - 1]]) {
			expect(outcome).toContain(`X-Email-Explorer-Id: ${id}`);
		}
	});
});
