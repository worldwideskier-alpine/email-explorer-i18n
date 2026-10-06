import {
	createExecutionContext,
	env,
	runInDurableObject,
	SELF,
	waitOnExecutionContext,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { EmailExplorer } from "../../src";
import {
	ensureLegacyMailboxGrants,
	resetLegacyGrantMemo,
} from "../../src/legacy-grants";
import { LEGACY_ADMIN_PERSON_ID } from "../../src/people";
import { enableAccountRecovery, giveSendingKey } from "./utils";

/**
 * An address is one person's, whichever kind of address it is.
 *
 * "Forgot password" mails the link to the sign-in address, and mail to an
 * address is filed in the mailbox of that address -- so whoever holds that
 * mailbox reads the link. Mailbox creation looked only at the grants and
 * login creation only at the logins, and both ways round it was a way to
 * another person's account: measured, a mailbox registered at somebody
 * else's sign-in address received their reset (root's too), and root making
 * a login at a customer's mailbox address handed the customer that login.
 *
 * So each side now asks about the other in the step that writes, a reset is
 * not sent where another person holds the mailbox (for collisions from
 * before), and the legacy backfill passes such an address over. One's own
 * addresses are left alone: a mailbox at one's own sign-in address, a login
 * moved onto one's own mailbox, and a holder bringing a deleted mailbox back.
 */

const API = "http://local.test/api/v1";
const PASSWORD = "password123";

const post = (body: unknown): RequestInit => ({
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify(body),
});

const auth = () => env.MAILBOX.get(env.MAILBOX.idFromName("AUTH"));

const signIn = async (email: string) => {
	const res = await SELF.fetch(
		`${API}/auth/login`,
		post({ email, password: PASSWORD }),
	);
	expect(res.status, `sign-in as ${email}`).toBe(200);
	return (await res.json<{ id: string }>()).id;
};

const as =
	(token: string) =>
	(url: string, options: RequestInit = {}) =>
		SELF.fetch(url, {
			...options,
			headers: { ...options.headers, Authorization: `Bearer ${token}` },
		});

/**
 * What Resend took for this recipient. The stub keeps everything for the
 * life of the process, so every test names its own addresses (see setUp).
 */
async function sentTo(recipient: string) {
	const all = await (await fetch("https://api.resend.com/__sent")).json<
		{ body: { to: string | string[] } }[]
	>();
	return all.filter((one) =>
		[one.body.to]
			.flat()
			.some((to) => String(to).toLowerCase() === recipient.toLowerCase()),
	);
}

async function resetTokensFor(userId: string) {
	let n = 0;
	const listed = await env.BUCKET.list({ prefix: "recovery-tokens/" });
	for (const object of listed.objects) {
		const stored = await env.BUCKET.get(object.key);
		if ((await stored?.json<{ userId: string }>())?.userId === userId) n++;
	}
	return n;
}

/**
 * Asked of the Worker directly: the reset is made after the answer (see
 * PostForgotPassword), and a context's background work can be waited for.
 */
async function forgot(email: string): Promise<[number, string]> {
	const worker = await import("../../dev/index");
	const ctx = createExecutionContext();
	const answer = await worker.default.fetch(
		new Request(`${API}/auth/forgot-password`, post({ email })),
		env,
		ctx,
	);
	await waitOnExecutionContext(ctx);
	return [answer.status, await answer.text()];
}

/**
 * A grant written straight in -- and, for a live mailbox, its settings
 * object -- which is what a collision from before these rules looks like.
 * The API can no longer make one.
 */
async function holdFromBefore(personId: string, address: string, live = true) {
	await runInDurableObject(auth(), async (_i, state) => {
		state.storage.sql.exec(
			"INSERT OR IGNORE INTO person_mailboxes (person_id, mailbox_id) VALUES (?, ?)",
			personId,
			address,
		);
	});
	if (live) await env.BUCKET.put(`mailboxes/${address}.json`, "{}");
}

const PEOPLE = ["victim", "squatter", "self"] as const;
type Who = (typeof PEOPLE)[number];

/**
 * Root and three people, each with a sending key and an address of this
 * test's own. Root registers first, so root is root.
 */
async function setUp() {
	resetLegacyGrantMemo();
	const tag = crypto.randomUUID().slice(0, 8);
	const at = (name: string) => `${name}-${tag}@example.net`;
	const rootAddress = at("op");
	await SELF.fetch(
		`${API}/auth/register`,
		post({ email: rootAddress, password: PASSWORD }),
	);
	const root = as(await signIn(rootAddress));
	await enableAccountRecovery();

	const rootUser = (await auth().getUserByEmail(rootAddress))?.id ?? "";
	await giveSendingKey(String(await auth().getPersonId(rootUser)));

	const people = {} as Record<
		Who,
		{ address: string; user: string; person: string }
	>;
	for (const who of PEOPLE) {
		const address = at(who);
		const made = await root(
			`${API}/root/accounts`,
			post({ email: address, password: PASSWORD, role: "admin" }),
		);
		expect(made.status, `root makes ${who}`).toBe(201);
		const user = (await auth().getUserByEmail(address))?.id ?? "";
		const person = String(await auth().getPersonId(user));
		await giveSendingKey(person);
		people[who] = { address, user, person };
	}
	return { at, root, rootAddress, rootUser, people };
}

describe("a mailbox at somebody else's sign-in address", () => {
	beforeEach(() => resetLegacyGrantMemo());

	it("is refused as 'already exists', root's address and another spelling included", async () => {
		const { people, rootAddress } = await setUp();
		const squatter = as(await signIn(people.squatter.address));

		for (const address of [people.victim.address, rootAddress.toUpperCase()]) {
			const made = await squatter(
				`${API}/mailboxes`,
				post({ email: address, name: "x" }),
			);
			expect(made.status, address).toBe(409);
			expect(await made.json(), address).toEqual({
				error: "Mailbox already exists",
			});
			// Nothing of it was kept: no grant, no settings object.
			expect(
				await env.BUCKET.head(`mailboxes/${address.toLowerCase()}.json`),
			).toBeNull();
		}
		expect(await auth().listPersonMailboxes(people.squatter.person)).toEqual(
			[],
		);
	});

	it("is let through at one's own sign-in address, and the reset still arrives", async () => {
		const { people } = await setUp();
		const self = as(await signIn(people.self.address));

		const made = await self(
			`${API}/mailboxes`,
			post({ email: people.self.address, name: "me" }),
		);
		expect(made.status).toBe(201);

		await forgot(people.self.address);
		expect(await sentTo(people.self.address)).toHaveLength(1);
		expect(await resetTokensFor(people.self.user)).toBe(1);
	});

	it("is let through when its holder brings back their own deleted mailbox, even where a login collides from before", async () => {
		const { people } = await setUp();
		// Held from before the rule, and since deleted: the grant outlives
		// it, and with it the address stays the holder's.
		await holdFromBefore(people.squatter.person, people.victim.address, false);
		const squatter = as(await signIn(people.squatter.address));

		const again = await squatter(
			`${API}/mailboxes`,
			post({ email: people.victim.address, name: "x" }),
		);
		expect(again.status).toBe(201);
		// And the victim's reset still does not go to it.
		await forgot(people.victim.address);
		expect(await sentTo(people.victim.address)).toHaveLength(0);
	});

	it("races a login at the same new address, and only one of them gets it", async () => {
		const { at, root, people } = await setUp();
		const squatter = as(await signIn(people.squatter.address));
		const address = at("race");

		const [mailbox, login] = await Promise.all([
			squatter(`${API}/mailboxes`, post({ email: address, name: "x" })),
			root(
				`${API}/root/accounts`,
				post({ email: address, password: PASSWORD, role: "admin" }),
			),
		]);
		expect(
			[mailbox.status, login.status].filter((s) => s === 201),
		).toHaveLength(1);
		// Whichever lost left nothing behind.
		const loginMade = (await auth().getUserByEmail(address)) !== null;
		const mailboxHeld = (
			await auth().listPersonMailboxes(people.squatter.person)
		).includes(address);
		expect(loginMade).not.toBe(mailboxHeld);
	});
});

describe("a sign-in at somebody else's mailbox", () => {
	beforeEach(() => resetLegacyGrantMemo());

	it("is refused when root makes a person there, deleted mailbox or live", async () => {
		const { at, root, people } = await setUp();
		const squatter = as(await signIn(people.squatter.address));
		const live = at("held");
		expect(
			(await squatter(`${API}/mailboxes`, post({ email: live, name: "x" })))
				.status,
		).toBe(201);
		const deleted = at("deleted");
		await holdFromBefore(people.squatter.person, deleted, false);

		for (const address of [live, deleted]) {
			const made = await root(
				`${API}/root/accounts`,
				post({ email: address, password: PASSWORD, role: "admin" }),
			);
			expect(made.status, address).toBe(400);
			expect(await made.json(), address).toEqual({
				error: "Mailbox already exists",
			});
			expect(await auth().getUserByEmail(address), address).toBeNull();
		}
		// An address nobody holds is still made, as ever.
		expect(
			(
				await root(
					`${API}/root/accounts`,
					post({ email: at("free"), password: PASSWORD, role: "admin" }),
				)
			).status,
		).toBe(201);
	});

	it("is refused as somebody's own spare, and let through at their own mailbox", async () => {
		const { at, people } = await setUp();
		const squatter = as(await signIn(people.squatter.address));
		const self = as(await signIn(people.self.address));
		const theirs = at("theirs");
		const mine = at("mine");
		expect(
			(await squatter(`${API}/mailboxes`, post({ email: theirs, name: "x" })))
				.status,
		).toBe(201);
		expect(
			(await self(`${API}/mailboxes`, post({ email: mine, name: "x" }))).status,
		).toBe(201);

		const spare = (email: string) =>
			self(
				`${API}/auth/admin/register`,
				post({ email, password: PASSWORD, currentPassword: PASSWORD }),
			);
		const refused = await spare(theirs);
		expect(refused.status).toBe(400);
		expect(await refused.json()).toEqual({ error: "Mailbox already exists" });
		expect(await auth().getUserByEmail(theirs)).toBeNull();

		expect((await spare(mine)).status).toBe(201);
	});

	it("is refused when a move is asked for, before any link is mailed, and let through to one's own mailbox", async () => {
		const { at, people } = await setUp();
		const squatter = as(await signIn(people.squatter.address));
		const self = as(await signIn(people.self.address));
		const theirs = at("theirs");
		const mine = at("mine");
		expect(
			(await squatter(`${API}/mailboxes`, post({ email: theirs, name: "x" })))
				.status,
		).toBe(201);
		expect(
			(await self(`${API}/mailboxes`, post({ email: mine, name: "x" }))).status,
		).toBe(201);

		const move = (newEmail: string) =>
			self(
				`${API}/auth/change-email`,
				post({ currentPassword: PASSWORD, newEmail }),
			);
		const refused = await move(theirs);
		expect(refused.status).toBe(409);
		expect(await refused.json()).toEqual({ error: "Mailbox already exists" });
		expect(await sentTo(theirs)).toHaveLength(0);
		expect(
			(await env.BUCKET.list({ prefix: "email-change-tokens/" })).objects,
		).toHaveLength(0);

		// Somebody else's login is still "already registered", as before.
		const login = await move(people.victim.address);
		expect(login.status).toBe(409);
		expect(await login.json()).toEqual({ error: "Email already registered" });

		expect((await move(mine)).status).toBe(200);
		expect(await sentTo(mine)).toHaveLength(1);
	});

	it("is refused at the confirmation when the mailbox was made while the link was out", async () => {
		const { at, people } = await setUp();
		const squatter = as(await signIn(people.squatter.address));
		const self = as(await signIn(people.self.address));
		const later = at("later");

		const asked = await self(
			`${API}/auth/change-email`,
			post({ currentPassword: PASSWORD, newEmail: later }),
		);
		expect(asked.status).toBe(200);
		const [pending] = (
			await env.BUCKET.list({ prefix: "email-change-tokens/" })
		).objects;
		const token = pending.key
			.replace("email-change-tokens/", "")
			.replace(".json", "");

		// Nobody signs in there yet, so the mailbox is the squatter's to make.
		expect(
			(await squatter(`${API}/mailboxes`, post({ email: later, name: "x" })))
				.status,
		).toBe(201);

		const confirmed = await SELF.fetch(
			`${API}/auth/confirm-email-change`,
			post({ token }),
		);
		expect(confirmed.status).toBe(409);
		expect(await confirmed.json()).toEqual({
			error: "Mailbox already exists",
		});
		expect((await auth().getUserByEmail(people.self.address))?.id).toBe(
			people.self.user,
		);
		expect(await auth().getUserByEmail(later)).toBeNull();

		// The same move onto a mailbox of one's own goes through.
		const mine = at("mine");
		expect(
			(await self(`${API}/mailboxes`, post({ email: mine, name: "x" }))).status,
		).toBe(201);
		expect(
			(
				await self(
					`${API}/auth/change-email`,
					post({ currentPassword: PASSWORD, newEmail: mine }),
				)
			).status,
		).toBe(200);
		const [second] = (await env.BUCKET.list({ prefix: "email-change-tokens/" }))
			.objects;
		const moved = await SELF.fetch(
			`${API}/auth/confirm-email-change`,
			post({
				token: second.key
					.replace("email-change-tokens/", "")
					.replace(".json", ""),
			}),
		);
		expect(moved.status).toBe(200);
		expect((await auth().getUserByEmail(mine))?.id).toBe(people.self.user);
	});

	it("is refused on a registration form that is open to everyone", async () => {
		const { at, people } = await setUp();
		const squatter = as(await signIn(people.squatter.address));
		const held = at("held");
		expect(
			(await squatter(`${API}/mailboxes`, post({ email: held, name: "x" })))
				.status,
		).toBe(201);

		// A deployment that opened the form for good, which is where a
		// stranger meets this rule; this one is closed after root.
		const open = EmailExplorer({ auth: { registerEnabled: true } });
		const register = (email: string) =>
			open.fetch(
				new Request(
					`${API}/auth/register`,
					post({ email, password: PASSWORD }),
				),
				{ ...env } as never,
				createExecutionContext(),
			);

		const refused = await register(held.toUpperCase());
		expect(refused.status).toBe(400);
		expect(await refused.json()).toEqual({ error: "Mailbox already exists" });
		expect(await auth().getUserByEmail(held)).toBeNull();

		expect((await register(at("newcomer"))).status).toBe(201);
	});
});

describe("a collision from before the rules", () => {
	beforeEach(() => resetLegacyGrantMemo());

	it("gets no reset stored or sent, and the same answer as an unknown address", async () => {
		const { at, people } = await setUp();
		await holdFromBefore(people.squatter.person, people.victim.address);

		const unknown = await forgot(at("nobody"));
		const typed = await forgot(people.victim.address.toUpperCase());
		const plain = await forgot(people.victim.address);

		expect(typed).toEqual(unknown);
		expect(plain).toEqual(unknown);
		expect(await sentTo(people.victim.address)).toHaveLength(0);
		expect(await resetTokensFor(people.victim.user)).toBe(0);

		// Narrow: somebody else's reset, with no collision, still goes.
		await forgot(people.self.address);
		expect(await sentTo(people.self.address)).toHaveLength(1);
	});

	it("does not send root's reset into the mailbox somebody holds at root's address", async () => {
		const { people, rootAddress, rootUser } = await setUp();
		await holdFromBefore(people.squatter.person, rootAddress);

		await forgot(rootAddress);
		expect(await sentTo(rootAddress)).toHaveLength(0);
		expect(await resetTokensFor(rootUser)).toBe(0);
	});
});

describe("the legacy backfill", () => {
	const MARKER_KEY = "system/mailbox-grants-backfilled.json";

	beforeEach(() => resetLegacyGrantMemo());

	it("passes over an unheld mailbox at somebody else's sign-in address, and grants the rest", async () => {
		const { at, root, people } = await setUp();
		// The person the migration folded the old administrators into.
		const oldAdmin = at("old-admin");
		expect(
			(
				await root(
					`${API}/root/accounts`,
					post({ email: oldAdmin, password: PASSWORD, role: "admin" }),
				)
			).status,
		).toBe(201);
		await runInDurableObject(auth(), async (_i, state) => {
			state.storage.sql.exec(
				"UPDATE users SET person_id = ? WHERE email = ?",
				LEGACY_ADMIN_PERSON_ID,
				oldAdmin,
			);
		});
		// Mailboxes in the bucket with no grant behind them: an ordinary one,
		// one at the old administrator's own sign-in address, and one at
		// somebody else's.
		const legacyBox = at("legacy-box");
		for (const address of [legacyBox, oldAdmin, people.victim.address]) {
			await env.BUCKET.put(`mailboxes/${address}.json`, "{}");
		}
		await env.BUCKET.delete(MARKER_KEY);
		resetLegacyGrantMemo();

		const result = await ensureLegacyMailboxGrants(env);

		expect(result).toMatchObject({ ran: true, mailboxes: 3, granted: 2 });
		expect(
			(await auth().listPersonMailboxes(LEGACY_ADMIN_PERSON_ID)).sort(),
		).toEqual([legacyBox, oldAdmin].sort());
		expect(await auth().getUserIdsForMailbox(people.victim.address)).toEqual(
			[],
		);
		// So the victim's reset is theirs to read, not the old person's.
		await forgot(people.victim.address);
		expect(await sentTo(people.victim.address)).toHaveLength(1);
	});

	it("is told so by the auth object, which grants the same address to the person who signs in with it", async () => {
		const { people } = await setUp();
		expect(
			await auth().giveMailboxToPerson(
				LEGACY_ADMIN_PERSON_ID,
				people.victim.address,
			),
		).toBe(false);
		expect(
			await auth().giveMailboxToPerson(
				people.victim.person,
				people.victim.address,
			),
		).toBe(true);
		expect(await auth().listPersonMailboxes(people.victim.person)).toEqual([
			people.victim.address,
		]);
	});
});
