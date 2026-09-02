import { SELF } from "cloudflare:test";
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
 */

const login = async (email: string, password = "password123") => {
	const res = await SELF.fetch("http://local.test/api/v1/auth/login", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email, password }),
	});
	return (await res.json<{ id: string }>()).id;
};

const as = (token: string) => (url: string, options: RequestInit = {}) =>
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
		body: JSON.stringify({ email: "root@test.com", password: "password123" }),
	});
	const rootToken = await login("root@test.com");

	for (const email of ["a@test.com", "b@test.com"]) {
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

	const a = { token: await login("a@test.com"), mailbox: "a-box@test.com" };
	const b = { token: await login("b@test.com"), mailbox: "b-box@test.com" };

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
				body: JSON.stringify({ name: "renamed" }),
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

		for (const who of [a, b]) {
			const [url, init] = CAPABILITIES[CAPABILITIES.length - 1].request(
				who.mailbox,
			);
			const res = await as(who.token)(url, init);
			expect([who.mailbox, res.status]).toEqual([who.mailbox, 201]);
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
});
