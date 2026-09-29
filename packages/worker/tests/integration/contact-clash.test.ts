import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	authenticatedFetch,
	createMailbox,
	mailboxId,
	testAuthBeforeAll,
} from "./utils";

/**
 * Changing a contact's address to one another contact already has.
 *
 * Creating such a contact answered 409; changing one into it let the UNIQUE
 * constraint's error out of the Durable Object, and the route answered 500 --
 * a server fault, for a clash the person could see and fix.
 */

const contacts = `http://local.test/api/v1/mailboxes/${mailboxId}/contacts`;

async function addContact(name: string, email: string): Promise<number> {
	const res = await authenticatedFetch(contacts, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ name, email }),
	});
	expect(res.status).toBe(201);
	return (await res.json<{ id: number }>()).id;
}

describe("a contact changed to an address already taken", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createMailbox();
	});

	// Asked of the object directly: through a route, an error from the
	// object leaves this test pool hanging rather than failing.
	it("is refused by the mailbox without an error", async () => {
		await addContact("A", "a@example.org");
		const b = await addContact("B", "b@example.org");
		const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
		await runInDurableObject(stub, async (instance) => {
			const mailbox = instance as unknown as {
				updateContact: (
					id: number,
					contact: { name?: string; email?: string },
				) => Promise<unknown>;
			};
			expect(await mailbox.updateContact(b, { email: "a@example.org" })).toBe(
				"taken",
			);
		});
	});

	it("is answered 409, and leaves both contacts as they were", async () => {
		await addContact("A", "a@example.org");
		const b = await addContact("B", "b@example.org");
		const res = await authenticatedFetch(`${contacts}/${b}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "B", email: "a@example.org" }),
		});
		expect(res.status).toBe(409);
		const list = await (await authenticatedFetch(contacts)).json<
			{ email: string }[]
		>();
		expect(list.map((c) => c.email).sort()).toEqual([
			"a@example.org",
			"b@example.org",
		]);
	});
});
