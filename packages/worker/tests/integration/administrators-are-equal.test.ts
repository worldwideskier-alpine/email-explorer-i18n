import { env, runInDurableObject, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { resetLegacyGrantMemo } from "../../src/legacy-grants";

/**
 * One administrator can do what another can.
 *
 * There is one way to make an administrator: root makes one. So two of them
 * are the same kind of thing, and any capability one has and the other does
 * not is a defect, not a policy -- there is no screen anywhere that grants or
 * withholds anything between them.
 *
 * It was not true. Restoring a backup asked for `session.isAdmin`, which is
 * the legacy `is_admin` column, and that column is set by registration for the
 * first account ever created and by nothing else. So restore belonged to one
 * particular person; every administrator made afterwards got 403 from the
 * endpoint, and the screen hid the control from them as well, which made a
 * refusal look like a missing feature.
 *
 * The parity is asserted by comparing status codes rather than by asserting a
 * particular one: what matters is not that restore returns 201, it is that it
 * returns the same thing to both of them.
 *
 * And the two have to differ in the way that mattered. Made the same way,
 * through root, neither carries the flag, so a check on `session.isAdmin`
 * refused them both alike -- parity held, and every capability but restore
 * could have been taken from both without a test noticing. So "A" carries
 * the legacy flag, as the first account used to, and "B" does not.
 */

const login = async (email: string, password = "password123") => {
	const res = await SELF.fetch("http://local.test/api/v1/auth/login", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email, password }),
	});
	return (await res.json<{ id: string }>()).id;
};

const as =
	(token: string) =>
	(url: string, options: RequestInit = {}) =>
		SELF.fetch(url, {
			...options,
			headers: { ...options.headers, Authorization: `Bearer ${token}` },
		});

const rawEmail = (subject: string) =>
	Buffer.from(
		[
			"From: sender@example.org",
			`Subject: ${subject}`,
			"MIME-Version: 1.0",
			'Content-Type: text/plain; charset="utf-8"',
			"",
			"body",
			"",
		].join("\r\n"),
		"utf8",
	).toString("base64");

/**
 * Root, and two administrators made the same way, each having registered one
 * mailbox. "A" and "B": nothing distinguishes them except the order they were
 * created in, which is precisely what must not matter.
 */
async function setUpTwoAdministrators() {
	await SELF.fetch("http://local.test/api/v1/auth/register", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			email: "root@example.com",
			password: "password123",
		}),
	});
	const rootToken = await login("root@example.com");

	for (const email of ["a@example.com", "b@example.com"]) {
		const created = await as(rootToken)(
			"http://local.test/api/v1/root/accounts",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ email, password: "password123", role: "admin" }),
			},
		);
		expect(created.status).toBe(201);
	}

	// The one difference there used to be between administrators.
	const flagged = await runInDurableObject(
		env.MAILBOX.get(env.MAILBOX.idFromName("AUTH")),
		async (_instance, state) => {
			state.storage.sql.exec(
				"UPDATE users SET is_admin = 1 WHERE email = ?",
				"a@example.com",
			);
			return state.storage.sql
				.exec(
					"SELECT email, is_admin FROM users WHERE email IN (?, ?) ORDER BY email",
					"a@example.com",
					"b@example.com",
				)
				.toArray();
		},
	);
	expect(flagged).toEqual([
		{ email: "a@example.com", is_admin: 1 },
		{ email: "b@example.com", is_admin: 0 },
	]);

	const a = {
		token: await login("a@example.com"),
		mailbox: "a-box@example.com",
	};
	const b = {
		token: await login("b@example.com"),
		mailbox: "b-box@example.com",
	};

	for (const who of [a, b]) {
		const made = await as(who.token)("http://local.test/api/v1/mailboxes", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: who.mailbox, name: who.mailbox }),
		});
		expect(made.status).toBe(201);
	}

	return { rootToken, a, b };
}

/** Every mailbox-scoped thing an administrator does, on their own mailbox. */
const CAPABILITIES: Array<{
	name: string;
	request: (mailbox: string) => [string, RequestInit];
}> = [
	{
		name: "open the mailbox",
		request: (m) => [`http://local.test/api/v1/mailboxes/${m}`, {}],
	},
	{
		name: "list its mail",
		request: (m) => [`http://local.test/api/v1/mailboxes/${m}/emails`, {}],
	},
	{
		name: "list its folders",
		request: (m) => [`http://local.test/api/v1/mailboxes/${m}/folders`, {}],
	},
	{
		name: "change its settings",
		request: (m) => [
			`http://local.test/api/v1/mailboxes/${m}`,
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				// `settings`, as the route's schema asks. `{ name }` was refused
				// with 400 -- to both, so the parity test was content with it.
				body: JSON.stringify({ settings: { fromName: "renamed" } }),
			},
		],
	},
	{
		name: "export it as mbox",
		request: (m) => [`http://local.test/api/v1/mailboxes/${m}/export`, {}],
	},
	{
		name: "list its stored backups",
		request: (m) => [`http://local.test/api/v1/mailboxes/${m}/backups`, {}],
	},
	// The one that was not equal. Kept last so a failure here reads as itself
	// rather than as the row above it.
	{
		name: "restore a backup into it",
		request: (m) => [
			`http://local.test/api/v1/admin/mailboxes/${m}/import`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					rawEmailBase64: rawEmail("restored"),
					folder: "inbox",
				}),
			},
		],
	},
];

describe("two administrators, on their own mailboxes", () => {
	beforeEach(() => {
		resetLegacyGrantMemo();
	});

	it("get the same answer to every request", async () => {
		const { a, b } = await setUpTwoAdministrators();

		const answers: Record<string, [number, number]> = {};
		for (const capability of CAPABILITIES) {
			const [urlA, initA] = capability.request(a.mailbox);
			const [urlB, initB] = capability.request(b.mailbox);
			answers[capability.name] = [
				(await as(a.token)(urlA, initA)).status,
				(await as(b.token)(urlB, initB)).status,
			];
		}

		for (const [name, [statusA, statusB]] of Object.entries(answers)) {
			expect([name, statusA]).toEqual([name, statusB]);
		}
	});

	/**
	 * And the answer is yes for both, not no for both. Parity on its own would
	 * be satisfied by an endpoint that refused everybody, which is not the
	 * thing being asked for.
	 */
	it("are both allowed, not both refused", async () => {
		const { a, b } = await setUpTwoAdministrators();

		// Every capability, not only restore: equal refusals of any other row
		// would have satisfied the parity above just as well.
		for (const capability of CAPABILITIES) {
			for (const who of [a, b]) {
				const [url, init] = capability.request(who.mailbox);
				const res = await as(who.token)(url, init);
				expect([capability.name, who.mailbox, res.ok]).toEqual([
					capability.name,
					who.mailbox,
					true,
				]);
			}
		}
	});
});

/**
 * Equal to each other is not the same as equal to everyone. Making restore
 * reachable must not make it reachable on somebody else's mailbox -- the flag
 * it replaced said yes to every mailbox in the deployment, so the account that
 * held it could write mail into anyone's.
 */
describe("but only on their own", () => {
	beforeEach(() => {
		resetLegacyGrantMemo();
	});

	it("refuses a restore into the other administrator's mailbox", async () => {
		const { a, b } = await setUpTwoAdministrators();

		const [intoB, init] = CAPABILITIES[CAPABILITIES.length - 1].request(
			b.mailbox,
		);
		expect((await as(a.token)(intoB, init)).status).toBe(403);
	});

	it("refuses root, which holds no mailbox at all", async () => {
		const { rootToken, a } = await setUpTwoAdministrators();

		const [intoA, init] = CAPABILITIES[CAPABILITIES.length - 1].request(
			a.mailbox,
		);
		expect((await as(rootToken)(intoA, init)).status).toBe(403);
	});

	it("refuses anyone with no session", async () => {
		const { a } = await setUpTwoAdministrators();

		const [intoA, init] = CAPABILITIES[CAPABILITIES.length - 1].request(
			a.mailbox,
		);
		expect((await SELF.fetch(intoA, init)).status).toBe(401);
	});

	/**
	 * And it refuses before reading the body.
	 *
	 * The check used to run after the request had been validated, so a caller
	 * with no rights here got their payload parsed on their behalf and were
	 * told whether it was well formed -- 400 for a malformed body where the
	 * true answer is 403, which is an answer about the body given to somebody
	 * with no standing to ask about it.
	 */
	it("says 403, not 400, to a stranger with a malformed body", async () => {
		const { a, b } = await setUpTwoAdministrators();

		const res = await as(a.token)(
			`http://local.test/api/v1/admin/mailboxes/${b.mailbox}/import`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ nothing: "that the schema allows" }),
			},
		);
		expect(res.status).toBe(403);
	});

	/**
	 * The mailbox id is an email address, so it arrives percent-encoded from
	 * the dashboard and unencoded from a script. Reading it off the path
	 * rather than off the validated params is only safe if both spellings
	 * reach the same mailbox.
	 */
	it("reads the same mailbox whether the address is encoded or not", async () => {
		const { a } = await setUpTwoAdministrators();

		for (const spelling of [a.mailbox, encodeURIComponent(a.mailbox)]) {
			const res = await as(a.token)(
				`http://local.test/api/v1/admin/mailboxes/${spelling}/import`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						rawEmailBase64: rawEmail(`encoded ${spelling}`),
						folder: "inbox",
					}),
				},
			);
			expect([spelling, res.status]).toEqual([spelling, 201]);
		}
	});
});
