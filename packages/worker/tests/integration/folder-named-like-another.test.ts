import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createMailbox, mailboxId, testAuthBeforeAll } from "./utils";

/**
 * A folder of one's own named like another folder's id.
 *
 * A folder is asked for by id or by name, and the lookup took whichever row
 * matched first. `folders.name` is unique only as typed, so a folder called
 * "inbox" -- the built-in Inbox is "Inbox" -- could be what "inbox" found,
 * and the inbox listed that folder's mail instead of its own.
 */

type Mailbox = {
	createFolder: (id: string, name: string) => Promise<unknown>;
	createEmail: (
		folder: string,
		email: Record<string, unknown>,
		a: unknown[],
	) => Promise<void>;
	getEmails: (o: { folder?: string }) => Promise<{ id: string }[]>;
};

const message = (id: string) => ({
	id,
	subject: id,
	sender: "a@example.org",
	recipient: mailboxId,
	date: new Date().toISOString(),
	read: false,
	starred: false,
	body: "b",
});

describe("a folder named like another folder's id", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createMailbox();
	});

	it("does not stand in for that folder", async () => {
		const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
		await runInDurableObject(stub, async (instance) => {
			const mailbox = instance as unknown as Mailbox;
			for (const [id, name] of [
				["u-inbox", "inbox"],
				["u-sent", "sent"],
				["u-spam", "spam"],
			]) {
				await mailbox.createFolder(id, name);
				await mailbox.createEmail(id, message(`in-${id}`), []);
			}
			await mailbox.createEmail("inbox", message("in-inbox"), []);
			await mailbox.createEmail("sent", message("in-sent"), []);
			await mailbox.createEmail("spam", message("in-spam"), []);

			for (const folder of ["inbox", "sent", "spam"]) {
				const ids = (await mailbox.getEmails({ folder })).map((e) => e.id);
				expect(ids, folder).toEqual([`in-${folder}`]);
			}
			// Still reachable by its own id, and by a name nothing else uses.
			expect(
				(await mailbox.getEmails({ folder: "u-inbox" })).map((e) => e.id),
			).toEqual(["in-u-inbox"]);
		});
	});
});
