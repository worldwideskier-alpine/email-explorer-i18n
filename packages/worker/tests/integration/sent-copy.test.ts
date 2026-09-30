import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keepSentCopy, prepareAttachments } from "../../src/sent-copy";
import {
	authenticatedFetch,
	createDummyMailbox,
	mailboxId,
	testAuthBeforeAll,
} from "./utils";

/**
 * The order of a send and of the copy it leaves in Sent.
 *
 * The attachments were decoded after Resend had taken the message, so one
 * that was not base64 went out and then failed the request; and a copy that
 * could not be filed answered 500 for a message that had left, which invited
 * the second send a retry is.
 */

describe("an attachment that is not base64", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
	});
	afterEach(() => vi.restoreAllMocks());

	it("is refused before anything is sent", async () => {
		const sent: string[] = [];
		const real = globalThis.fetch;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = input instanceof Request ? input.url : String(input);
			if (new URL(url).hostname === "api.resend.com") sent.push(url);
			return real(input, init);
		});

		const res = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/emails`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					from: mailboxId,
					to: "someone@example.org",
					subject: "with a broken file",
					text: "x",
					attachments: [
						{
							filename: "a.bin",
							content: "not base64 at all!!",
							type: "application/octet-stream",
							disposition: "attachment",
						},
					],
				}),
			},
		);
		expect(res.status).toBe(400);
		expect(sent).toEqual([]);
	});

	it("is found by the preparation, and a good one is not", () => {
		expect(prepareAttachments([{ content: "%%%" }])).toBeNull();
		expect(prepareAttachments([{ content: btoa("ok") }])?.[0].bytes).toEqual(
			new TextEncoder().encode("ok"),
		);
		expect(prepareAttachments(undefined)).toEqual([]);
	});
});

describe("a copy that cannot be filed", () => {
	it("is said, not thrown", async () => {
		const failing = {
			createEmail: async () => {
				throw new Error("storage reset");
			},
		};
		expect(
			await keepSentCopy(
				env as never,
				failing as never,
				"m1",
				{
					subject: "s",
					sender: "a@example.org",
					recipient: "b@example.org",
					date: new Date().toISOString(),
					body: "",
				} as never,
				[],
			),
		).toBe(false);
	});
});
