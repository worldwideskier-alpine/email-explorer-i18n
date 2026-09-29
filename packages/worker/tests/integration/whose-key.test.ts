import { env, runInDurableObject, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	authenticatedFetch,
	createMailbox,
	mailboxId,
	personId,
	testAuthBeforeAll,
} from "./utils";

/**
 * Whose key a message goes out with.
 *
 * The key decides who pays, and AGENTS.md's rule is that it is the key of
 * the person whose mail it is: a mailbox's with its holder's, a reset with
 * the person being reset's. Nothing checked it -- the Resend stub answered
 * any request, with any key or none -- so a send billed to somebody else
 * passed every test. The stub now records what it took (vitest.config.mts).
 */

const HOLDER_KEY = "re_holder_own_key";
const OTHER_KEY = "re_somebody_else";

const keyOf = async (person: string, key: string) =>
	env.BUCKET.put(
		`settings/person/${encodeURIComponent(person)}.json`,
		JSON.stringify({ resendApiKey: key }),
	);

/** What Resend was sent for this recipient, and with which key. */
async function sentTo(recipient: string) {
	const all = await (await fetch("https://api.resend.com/__sent")).json<
		{ authorization: string; body: { to: string | string[] } }[]
	>();
	return all.filter((one) =>
		[one.body.to].flat().some((to) => String(to).includes(recipient)),
	);
}

describe("a mailbox's mail", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createMailbox();
		await keyOf(personId, HOLDER_KEY);
		// Somebody else with a key of their own, which must not be used.
		await keyOf("person-other", OTHER_KEY);
	});

	it("goes out with its holder's key", async () => {
		const recipient = `whose-key-${crypto.randomUUID()}@example.net`;
		const id = crypto.randomUUID();
		await runInDurableObject(
			env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId)),
			async (_i, state) => {
				state.storage.sql.exec(
					`INSERT INTO emails (id, folder_id, subject, sender, recipient, date, body)
					 VALUES (?, 'inbox', 's', ?, ?, ?, '<p>x</p>')`,
					id,
					recipient,
					mailboxId,
					new Date().toISOString(),
				);
			},
		);
		const reply = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/emails/${id}/reply`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					to: recipient,
					from: mailboxId,
					subject: "Re: s",
					html: "<p>r</p>",
				}),
			},
		);
		expect(reply.status).toBe(201);
		const sent = await sentTo(recipient);
		expect(sent.map((one) => one.authorization)).toEqual([
			`Bearer ${HOLDER_KEY}`,
		]);
	});
});

describe("a password reset", () => {
	it("goes out with the key of the person being reset", async () => {
		// Root registers first; the person being reset is somebody else.
		await SELF.fetch("http://local.test/api/v1/auth/register", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				email: "op@example.com",
				password: "password123",
			}),
		});
		const rootLogin = await (
			await SELF.fetch("http://local.test/api/v1/auth/login", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					email: "op@example.com",
					password: "password123",
				}),
			})
		).json<{ id: string; userId: string }>();
		await SELF.fetch(
			"http://local.test/api/v1/root/settings/account-recovery",
			{
				method: "PUT",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${rootLogin.id}`,
				},
				body: JSON.stringify({ fromEmail: "noreply@example.com" }),
			},
		);
		const auth = env.MAILBOX.get(env.MAILBOX.idFromName("AUTH"));
		const address = `resettable-${crypto.randomUUID()}@example.net`;
		const user = await auth.register(address, "password123", false);
		const theirs = await auth.getPersonId(user.id);
		await keyOf(String(theirs), HOLDER_KEY);
		await keyOf(String(await auth.getPersonId(rootLogin.userId)), OTHER_KEY);

		const asked = await SELF.fetch(
			"http://local.test/api/v1/auth/forgot-password",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ email: address }),
			},
		);
		expect(asked.status).toBe(200);
		expect((await sentTo(address)).map((one) => one.authorization)).toEqual([
			`Bearer ${HOLDER_KEY}`,
		]);
	});
});
