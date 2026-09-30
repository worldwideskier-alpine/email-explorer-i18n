import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { asContentId } from "../../src/resend";
import {
	authenticatedFetch,
	createMailbox,
	mailboxId,
	testAuthBeforeAll,
} from "./utils";

/**
 * An inline picture goes to Resend with the id its HTML names it by.
 *
 * The routes took `disposition: "inline"` and a `contentId`, and the request
 * to Resend carried neither: the picture went as a plain attachment, the
 * HTML's `cid:` reference pointed at nothing, and the recipient saw a broken
 * image with the file listed below the message. Resend's own field is
 * `content_id` (its send-email reference, and its SDK maps `contentId` to
 * it), read from a GitHub runner on 2026-09-30.
 */

const PNG = "iVBORw0KGgo=";

type Sent = {
	body: {
		to: string | string[];
		attachments?: { filename: string; content_id?: string }[];
	};
};

async function sentTo(recipient: string) {
	const all = await (await fetch("https://api.resend.com/__sent")).json<
		Sent[]
	>();
	const mine = all.filter((one) =>
		[one.body.to].flat().some((to) => String(to) === recipient),
	);
	expect(mine).toHaveLength(1);
	return mine[0].body.attachments ?? [];
}

const attachments = [
	{
		content: PNG,
		filename: "logo.png",
		type: "image/png",
		disposition: "inline",
		contentId: "<logo@example.net>",
	},
	{
		content: PNG,
		filename: "report.png",
		type: "image/png",
		disposition: "attachment",
		contentId: "report@example.net",
	},
];

async function anOriginal() {
	const id = crypto.randomUUID();
	await runInDurableObject(
		env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId)),
		async (_i, state) => {
			state.storage.sql.exec(
				`INSERT INTO emails (id, folder_id, subject, sender, recipient, date, body)
				 VALUES (?, 'inbox', 's', 'a@example.net', ?, ?, '<p>x</p>')`,
				id,
				mailboxId,
				new Date().toISOString(),
			);
		},
	);
	return id;
}

describe("an inline picture, sent", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createMailbox();
	});

	const routes: [string, () => Promise<string>][] = [
		["a new message", async () => `/api/v1/mailboxes/${mailboxId}/emails`],
		[
			"a reply",
			async () =>
				`/api/v1/mailboxes/${mailboxId}/emails/${await anOriginal()}/reply`,
		],
		[
			"a forward",
			async () =>
				`/api/v1/mailboxes/${mailboxId}/emails/${await anOriginal()}/forward`,
		],
	];

	for (const [label, path] of routes) {
		it(`keeps its Content-ID in ${label}, and an attachment has none`, async () => {
			const recipient = `inline-${crypto.randomUUID()}@example.net`;
			const response = await authenticatedFetch(
				`http://local.test${await path()}`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						to: recipient,
						from: mailboxId,
						subject: "s",
						html: '<p><img src="cid:logo@example.net"></p>',
						attachments,
					}),
				},
			);
			expect(response.status).toBeLessThan(300);
			const sent = await sentTo(recipient);
			expect(sent.map((one) => one.filename)).toEqual([
				"logo.png",
				"report.png",
			]);
			expect(sent[0].content_id).toBe("logo@example.net");
			expect(sent[1]).not.toHaveProperty("content_id");
		});
	}
});

describe("asContentId", () => {
	it("takes the angle brackets off", () => {
		expect(asContentId("<a.b@example.net>")).toBe("a.b@example.net");
		expect(asContentId("logo-image")).toBe("logo-image");
	});

	// Resend writes it into a header of the message.
	it("refuses what could reach a header as more than an id", () => {
		for (const value of [
			"a\r\nBcc: x@example.net",
			"a b",
			"<a>b>",
			"",
			"<>",
			undefined,
		]) {
			expect(asContentId(value)).toBeUndefined();
		}
	});
});
