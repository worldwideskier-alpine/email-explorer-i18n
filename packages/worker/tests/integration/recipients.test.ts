import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	authenticatedFetch,
	createMailbox,
	mailboxId,
	testAuthBeforeAll,
} from "./utils";

/**
 * Multiple To recipients, plus Cc and Bcc.
 *
 * Two things need checking and they need different routes to observe them:
 * what left for Resend, and what was filed in the Sent folder. The subject
 * marker makes the Resend stub echo the request back through the error path,
 * which is the only way the caller ever sees it -- but the error path returns
 * before anything is stored, so the storage assertions use ordinary sends.
 */
const ECHO = "ECHO_RESEND_REQUEST";

const send = (body: Record<string, unknown>) =>
	authenticatedFetch(`http://local.test/api/v1/mailboxes/${mailboxId}/emails`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ from: mailboxId, ...body }),
	});

async function sentRow(id: string) {
	// @ts-expect-error test binding
	const doStub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
	return runInDurableObject(doStub, async (_instance, state) => {
		const rows = state.storage.sql
			.exec("SELECT recipient, cc, bcc, folder_id FROM emails WHERE id = ?", id)
			.toArray();
		return rows[0] as {
			recipient: string;
			cc: string | null;
			bcc: string | null;
			folder_id: string;
		};
	});
}

describe("multiple recipients, cc and bcc", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createMailbox();
	});

	describe("what reaches Resend", () => {
		it("passes every To address through, not just the first", async () => {
			const response = await send({
				to: ["one@example.com", "two@example.com", "three@example.com"],
				subject: ECHO,
				text: "body",
			});

			expect(response.status).toBe(500);
			const sent = JSON.parse(
				((await response.json()) as { error: string }).error.replace(
					/^Resend API error: 500 /,
					"",
				),
			);
			expect(sent.to).toEqual([
				"one@example.com",
				"two@example.com",
				"three@example.com",
			]);
		});

		it("passes cc and bcc through", async () => {
			const response = await send({
				to: ["to@example.com"],
				cc: ["cc1@example.com", "cc2@example.com"],
				bcc: ["bcc@example.com"],
				subject: ECHO,
				text: "body",
			});

			const sent = JSON.parse(
				((await response.json()) as { error: string }).error.replace(
					/^Resend API error: 500 /,
					"",
				),
			);
			expect(sent.cc).toEqual(["cc1@example.com", "cc2@example.com"]);
			expect(sent.bcc).toEqual(["bcc@example.com"]);
		});

		it("omits cc and bcc entirely when they are empty", async () => {
			const response = await send({
				to: ["to@example.com"],
				cc: [],
				bcc: [],
				subject: ECHO,
				text: "body",
			});

			const raw = ((await response.json()) as { error: string }).error;
			const sent = JSON.parse(raw.replace(/^Resend API error: 500 /, ""));
			// Resend rejects an empty array, so the keys must be absent rather
			// than present and empty.
			expect(sent).not.toHaveProperty("cc");
			expect(sent).not.toHaveProperty("bcc");
		});
	});

	describe("what is filed in Sent", () => {
		it("stores every To address as a comma-separated list", async () => {
			const response = await send({
				to: ["one@example.com", "two@example.com"],
				subject: "Stored recipients",
				text: "body",
			});
			expect(response.status).toBe(201);
			const { id } = (await response.json()) as { id: string };

			const row = await sentRow(id);
			expect(row.folder_id).toBe("sent");
			expect(row.recipient).toBe("one@example.com, two@example.com");
		});

		it("stores cc and bcc", async () => {
			const response = await send({
				to: ["to@example.com"],
				cc: ["cc@example.com"],
				bcc: ["bcc1@example.com", "bcc2@example.com"],
				subject: "Stored cc and bcc",
				text: "body",
			});
			const { id } = (await response.json()) as { id: string };

			const row = await sentRow(id);
			expect(row.cc).toBe("cc@example.com");
			expect(row.bcc).toBe("bcc1@example.com, bcc2@example.com");
		});

		it("leaves cc and bcc null when they were not given", async () => {
			const response = await send({
				to: "single@example.com",
				subject: "No cc",
				text: "body",
			});
			const { id } = (await response.json()) as { id: string };

			const row = await sentRow(id);
			expect(row.recipient).toBe("single@example.com");
			expect(row.cc).toBeNull();
			expect(row.bcc).toBeNull();
		});
	});

	describe("validation", () => {
		it("rejects an empty To list", async () => {
			const response = await send({
				to: [],
				subject: "Nobody",
				text: "body",
			});
			expect(response.status).toBe(400);
		});

		it("rejects a comma-separated string, which is not one address", async () => {
			const response = await send({
				to: "one@example.com, two@example.com",
				subject: "Comma in a string",
				text: "body",
			});
			expect(response.status).toBe(400);
		});

		it("rejects a malformed cc address", async () => {
			const response = await send({
				to: ["to@example.com"],
				cc: ["not-an-address"],
				subject: "Bad cc",
				text: "body",
			});
			expect(response.status).toBe(400);
		});
	});

	describe("received mail", () => {
		it("records the whole To and Cc lists, not just the first address", async () => {
			const raw = [
				"From: sender@example.com",
				`To: ${mailboxId}, colleague@example.com`,
				"Cc: watcher@example.com, boss@example.com",
				"Subject: With a cc",
				"MIME-Version: 1.0",
				'Content-Type: text/plain; charset="utf-8"',
				"",
				"body",
			].join("\r\n");

			const imported = await authenticatedFetch(
				`http://local.test/api/v1/admin/mailboxes/${mailboxId}/import`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ rawEmailBase64: btoa(raw) }),
				},
			);
			expect(imported.status).toBe(201);
			const { id } = (await imported.json()) as { id: string };

			const read = await authenticatedFetch(
				`http://local.test/api/v1/mailboxes/${mailboxId}/emails/${id}`,
			);
			const email = (await read.json()) as {
				recipient: string;
				cc: string | null;
				bcc: string | null;
			};
			expect(email.recipient).toBe(`${mailboxId}, colleague@example.com`);
			expect(email.cc).toBe("watcher@example.com, boss@example.com");
			// Inbound mail never carries a bcc.
			expect(email.bcc).toBeNull();
		});
	});

	describe("drafts keep the raw text of each field", () => {
		it("round-trips a half-typed cc through save and read", async () => {
			const save = await authenticatedFetch(
				`http://local.test/api/v1/mailboxes/${mailboxId}/drafts`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						from: mailboxId,
						to: "one@example.com, two@example.com",
						cc: "half@",
						bcc: "bcc@example.com",
						subject: "Draft",
						html: "<p>later</p>",
					}),
				},
			);
			expect(save.status).toBe(201);
			const { id } = (await save.json()) as { id: string };

			const read = await authenticatedFetch(
				`http://local.test/api/v1/mailboxes/${mailboxId}/emails/${id}`,
			);
			const draft = (await read.json()) as {
				recipient: string;
				cc: string;
				bcc: string;
			};
			expect(draft.recipient).toBe("one@example.com, two@example.com");
			expect(draft.cc).toBe("half@");
			expect(draft.bcc).toBe("bcc@example.com");
		});
	});
});
