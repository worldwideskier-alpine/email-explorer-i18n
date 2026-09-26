import { beforeEach, describe, expect, it } from "vitest";
import {
	authenticatedFetch,
	createDummyMailbox,
	mailboxId,
	testAuthBeforeAll,
} from "./utils";

/**
 * The dashboard encodes every path segment it sends, the mailbox address
 * among them ("@" becomes "%40"). An id is somebody's to choose, and one
 * with a "/" or "?" in it named another path; the Worker has to read the
 * encoded form as the same mailbox, at the gate and in the route alike.
 */
describe("a mailbox address encoded in the path", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
	});

	it("reaches the same mailbox as the plain one", async () => {
		const encoded = encodeURIComponent(mailboxId);
		expect(encoded).toContain("%40");

		const plain = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}`,
		);
		const viaEncoded = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${encoded}`,
		);
		expect(viaEncoded.status).toBe(200);
		expect(await viaEncoded.json()).toEqual(await plain.json());

		const list = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${encoded}/emails?folder=inbox`,
		);
		expect(list.status).toBe(200);

		const saved = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${encoded}`,
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ settings: { fromName: "Encoded" } }),
			},
		);
		expect(saved.status).toBe(200);
		expect(
			(
				await (
					await authenticatedFetch(
						`http://local.test/api/v1/mailboxes/${mailboxId}`,
					)
				).json<{ settings: { fromName: string } }>()
			).settings.fromName,
		).toBe("Encoded");
	});
});
