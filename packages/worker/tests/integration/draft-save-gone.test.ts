import {
	createExecutionContext,
	env,
	runInDurableObject,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	authenticatedFetch,
	createMailbox,
	mailboxId,
	sessionToken,
	testAuthBeforeAll,
} from "./utils";

/**
 * Saving a draft that has just been sent or deleted.
 *
 * The route looks the draft up, then writes to it where it is still a draft.
 * One sent in between is not a draft any more, so the write changed nothing
 * -- and the save was answered 200 "saved", which the screen believes.
 */

async function makeDraft(): Promise<string> {
	const res = await authenticatedFetch(
		`http://local.test/api/v1/mailboxes/${mailboxId}/drafts`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				from: mailboxId,
				subject: "draft",
				html: "<p>x</p>",
			}),
		},
	);
	expect(res.status).toBe(201);
	return (await res.json<{ id: string }>()).id;
}

const edit = {
	subject: "edited",
	sender: mailboxId,
	recipient: "someone@example.org",
	cc: null,
	bcc: null,
	body: "<p>edited</p>",
};

describe("a draft saved after it stopped being one", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createMailbox();
	});

	it("is not reported saved by the mailbox", async () => {
		const id = await makeDraft();
		const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
		await stub.moveEmail(id, "sent");
		await runInDurableObject(stub, async (instance) => {
			const mailbox = instance as unknown as {
				updateDraftContent: (id: string, e: typeof edit) => Promise<unknown>;
				getEmail: (id: string) => Promise<{ subject: string } | null>;
			};
			expect(await mailbox.updateDraftContent(id, edit)).toBeNull();
			expect((await mailbox.getEmail(id))?.subject).toBe("draft");
		});
	});

	// The route's own lookup still sees a draft, as it would have a moment
	// before the send; the message has gone to Sent by the time it writes.
	it("is answered 404 by the route", async () => {
		const id = await makeDraft();
		const real = env.MAILBOX;
		const ours = real.idFromName(mailboxId);
		await real.get(ours).moveEmail(id, "sent");
		const MAILBOX = {
			idFromName: (name: string) => real.idFromName(name),
			get: (doId: DurableObjectId) => {
				const stub = real.get(doId);
				if (!doId.equals(ours)) return stub;
				// Only what the route asks of this mailbox: an RPC stub cannot
				// be wrapped in a Proxy, since every property is a remote call.
				return {
					getEmail: async (emailId: string) => ({
						...(await stub.getEmail(emailId)),
						folder_id: "draft",
					}),
					updateDraftContent: (
						...a: Parameters<typeof stub.updateDraftContent>
					) => stub.updateDraftContent(...a),
				};
			},
		};
		const worker = await import("../../dev/index");
		const res = await worker.default.fetch(
			new Request(
				`http://local.test/api/v1/mailboxes/${mailboxId}/drafts/${id}`,
				{
					method: "PUT",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${sessionToken}`,
					},
					body: JSON.stringify({
						from: mailboxId,
						to: "someone@example.org",
						subject: "edited",
						html: "<p>edited</p>",
					}),
				},
			),
			{ ...env, MAILBOX } as never,
			createExecutionContext(),
		);
		expect(res.status).toBe(404);
	});
});
