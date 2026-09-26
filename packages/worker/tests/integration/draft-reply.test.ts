import { beforeEach, describe, expect, it } from "vitest";
import {
	authenticatedFetch,
	createDummyMailbox,
	mailboxId,
	testAuthBeforeAll,
} from "./utils";

/**
 * A reply saved as a draft remembers what it answers, so that sending it
 * later goes through the reply route and keeps the thread.
 */

const API = `http://local.test/api/v1/mailboxes/${mailboxId}`;
const json = (method: string, body: unknown) => ({
	method,
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify(body),
});

async function importOne(): Promise<string> {
	const raw = `From: them@example.org\r\nTo: ${mailboxId}\r\nMessage-ID: <q1@example.org>\r\nSubject: Question\r\n\r\nCan you?`;
	const res = await authenticatedFetch(
		`http://local.test/api/v1/admin/mailboxes/${mailboxId}/import`,
		json("POST", { folder: "inbox", rawEmailBase64: btoa(raw) }),
	);
	return (await res.json<{ id: string }>()).id;
}

const draftBody = (extra: object) => ({
	to: "them@example.org",
	from: mailboxId,
	subject: "Re: Question",
	html: "<p>Yes</p>",
	...extra,
});

describe("a reply saved as a draft", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
	});

	it("keeps the message it answers, through a save and an update", async () => {
		const parent = await importOne();
		const saved = await authenticatedFetch(
			`${API}/drafts`,
			json("POST", draftBody({ replyTo: parent })),
		);
		expect(saved.status).toBe(201);
		const { id } = await saved.json<{ id: string }>();

		// An update that does not mention it leaves it as it was.
		expect(
			(
				await authenticatedFetch(
					`${API}/drafts/${id}`,
					json("PUT", draftBody({})),
				)
			).status,
		).toBe(200);

		const draft = await (await authenticatedFetch(`${API}/emails/${id}`)).json<{
			draft_reply_to: string | null;
		}>();
		expect(draft.draft_reply_to).toBe(parent);
	});

	/**
	 * The id comes from the browser. One naming no message here would send
	 * the reply into somebody else's thread.
	 */
	it("keeps nothing that is not a message in this mailbox", async () => {
		const saved = await authenticatedFetch(
			`${API}/drafts`,
			json("POST", draftBody({ replyTo: "somebody-elses-message" })),
		);
		const { id } = await saved.json<{ id: string }>();
		const draft = await (await authenticatedFetch(`${API}/emails/${id}`)).json<{
			draft_reply_to: string | null;
		}>();
		expect(draft.draft_reply_to).toBeNull();
	});
});
