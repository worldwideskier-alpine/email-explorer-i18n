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
async function forgot(
	email: string,
	on: object = env,
): Promise<[number, string]> {
	const worker = await import("../../dev/index");
	const ctx = createExecutionContext();
	const answer = await worker.default.fetch(
		new Request(`${API}/auth/forgot-password`, post({ email })),
		on as typeof env,
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

describe("one address in two spellings", () => {
	beforeEach(() => resetLegacyGrantMemo());

	it("is refused as a mailbox at a sign-in address kept in capitals from before, and let through to its own person", async () => {
		const { people } = await setUp();
		// Sign-in rows from before addresses were lowercased keep their
		// capitals, and sign-in finds them by either spelling. A reset sent
		// to one is filed in the mailbox of the lowercased address.
		const kept = people.victim.address.replace(/^v/, "V");
		await runInDurableObject(auth(), async (_i, state) => {
			state.storage.sql.exec(
				"UPDATE users SET email = ? WHERE id = ?",
				kept,
				people.victim.user,
			);
		});
		const squatter = as(await signIn(people.squatter.address));
		const victim = as(await signIn(people.victim.address));

		const taken = await squatter(
			`${API}/mailboxes`,
			post({ email: people.victim.address, name: "x" }),
		);
		expect(taken.status).toBe(409);

		const own = await victim(
			`${API}/mailboxes`,
			post({ email: people.victim.address, name: "me" }),
		);
		expect(own.status).toBe(201);
		await forgot(people.victim.address);
		expect(await sentTo(people.victim.address)).toHaveLength(1);
	});

	it("is refused as a sign-in at a mailbox granted in capitals from before", async () => {
		const { at, root, people } = await setUp();
		// A capitalised mailbox receives nothing -- inbound mail is filed by
		// the lowercased recipient -- so this is not about whose reset it
		// would read. It is the two questions agreeing on what one address
		// is, as sign-in does.
		const address = at("granted");
		await holdFromBefore(
			people.squatter.person,
			address.replace(/^g/, "G"),
			false,
		);

		const made = await root(
			`${API}/root/accounts`,
			post({ email: address, password: PASSWORD, role: "admin" }),
		);
		expect(made.status).toBe(400);
		expect(await made.json()).toEqual({ error: "Mailbox already exists" });
	});
});

describe("a sign-in at somebody else's mailbox", () => {
	beforeEach(() => resetLegacyGrantMemo());

	it("races a mailbox at the same new address inside the auth object, either one first, and only one of them gets it", async () => {
		const { at, people } = await setUp();
		// Sent at once, straight to the auth object, in both orders and for
		// each way a login comes to an address. The route-level race above
		// is decided by whichever request reaches the object first, which
		// has been the login; these send the mailbox first as well.
		// Each is ready to send in one call, so that the order sent is the
		// order the object takes them in.
		const makers = {
			register: async () => (address: string) =>
				auth().register(address, PASSWORD, false, people.self.person),
			registerFromForm: async () => (address: string) =>
				auth().registerFromForm(address, PASSWORD, false),
			confirmEmailChange: async () => {
				const stamp = String(await auth().emailChangeStamp(people.self.user));
				return (address: string) =>
					auth().confirmEmailChange(people.self.user, address, stamp);
			},
		};
		for (const [make, ready] of Object.entries(makers)) {
			for (const mailboxFirst of [true, false]) {
				const label = `${make}, ${mailboxFirst ? "mailbox" : "login"} first`;
				const address = at(`both-${make}-${mailboxFirst}`);
				const login = await ready();
				const claim = () =>
					auth().claimMailboxForPersonOf(people.squatter.user, address);
				const [claimed, made] = mailboxFirst
					? await Promise.allSettled([claim(), login(address)])
					: await Promise.allSettled([login(address), claim()]).then(
							([l, c]) => [c, l] as const,
						);

				const loginMade =
					made.status === "fulfilled" &&
					(make !== "confirmEmailChange" || made.value === "changed");
				const mailboxClaimed =
					claimed.status === "fulfilled" && claimed.value === true;
				expect([loginMade, mailboxClaimed], label).toContain(true);
				expect(loginMade, label).not.toBe(mailboxClaimed);
				expect((await auth().getUserByEmail(address)) !== null, label).toBe(
					loginMade,
				);
				expect(
					(await auth().listPersonMailboxes(people.squatter.person)).includes(
						address,
					),
					label,
				).toBe(mailboxClaimed);
			}
		}
	});

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

	/**
	 * Nothing proves an address is its taker's, so a mailbox made and deleted
	 * at an address that never delivers here holds it as firmly as a real
	 * one, and root -- which sees nobody's mailboxes -- is not told by whom.
	 * What frees it is deleting the person who holds it, which is where the
	 * admin guide sends root; this holds both halves of what it says.
	 */
	it("is refused at an address a deleted mailbox holds, until the person who made it is deleted", async () => {
		const { at, root, people } = await setUp();
		const squatter = as(await signIn(people.squatter.address));
		const held = at("newhire");
		const path = `${API}/mailboxes/${encodeURIComponent(held)}`;
		expect(
			(await squatter(`${API}/mailboxes`, post({ email: held, name: "x" })))
				.status,
		).toBe(201);
		const unlocked = await squatter(path, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ settings: { deletionLocked: false } }),
		});
		expect(unlocked.status).toBe(200);
		expect((await squatter(path, { method: "DELETE" })).status).toBe(204);
		expect(await env.BUCKET.head(`mailboxes/${held}.json`)).toBeNull();

		const make = () =>
			root(
				`${API}/root/accounts`,
				post({ email: held, password: PASSWORD, role: "admin" }),
			);
		const refused = await make();
		expect(refused.status).toBe(400);
		expect(await refused.json()).toEqual({ error: "Mailbox already exists" });
		expect(await auth().getUserByEmail(held)).toBeNull();

		const lock = await root(
			`${API}/root/accounts/${people.squatter.person}/lock`,
			post({ locked: false }),
		);
		expect(lock.status).toBe(200);
		const gone = await root(`${API}/root/accounts/${people.squatter.person}`, {
			method: "DELETE",
		});
		expect(gone.status).toBe(200);
		expect((await make()).status).toBe(201);
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

/**
 * The deployment's env, with each of `pauses` run just before the auth
 * object's call of that number (from 0) among those a request makes once the
 * account has been looked up -- which, for "forgot password", are the
 * reset's own steps. `ran` lists the ones there was a call for.
 */
function pausedAt(pauses: Record<number, () => Promise<void>>) {
	const authId = env.MAILBOX.idFromName("AUTH");
	const ran: number[] = [];
	let lookedUp = false;
	let calls = 0;
	const MAILBOX = new Proxy(env.MAILBOX, {
		get(namespace, name) {
			if (name !== "get") {
				const value = Reflect.get(namespace, name);
				return typeof value === "function" ? value.bind(namespace) : value;
			}
			return (id: DurableObjectId) => {
				const stub = namespace.get(id);
				if (!id.equals(authId)) return stub;
				return new Proxy(stub, {
					get(target, method) {
						// Not a promise, and nothing else is asked of it here.
						if (method === "then" || typeof method === "symbol") {
							return undefined;
						}
						return async (...args: unknown[]) => {
							if (lookedUp) {
								const step = calls++;
								if (pauses[step]) {
									ran.push(step);
									await pauses[step]();
								}
							}
							const call = Reflect.get(target, method) as (
								...a: unknown[]
							) => Promise<unknown>;
							const answer = await call(...args);
							if (method === "getUserByEmail") lookedUp = true;
							return answer;
						};
					},
				});
			};
		},
	});
	return { env: { ...env, MAILBOX }, ran };
}

describe("a reset being made while its login moves", () => {
	beforeEach(() => resetLegacyGrantMemo());

	it("is no use to whoever makes a mailbox of the address it left, wherever the two land", async () => {
		const { at, root, people } = await setUp();
		const squatter = as(await signIn(people.squatter.address));

		// The owner confirms a move off the address, which frees it, and
		// somebody makes a mailbox of it: each at one of the reset's own
		// calls to the auth object, the move no later than the mailbox, for
		// every pair there are calls for.
		const tried: string[] = [];
		let run = 0;
		for (let moveAt = 0; moveAt < 6; moveAt++) {
			let moved = true;
			for (let squatAt = moveAt; squatAt < 6; squatAt++) {
				run++;
				const address = at(`moving-${run}`);
				const movedTo = at(`moved-${run}`);
				expect(
					(
						await root(
							`${API}/root/accounts`,
							post({ email: address, password: PASSWORD, role: "admin" }),
						)
					).status,
				).toBe(201);
				const owner = (await auth().getUserByEmail(address))?.id ?? "";
				await giveSendingKey(String(await auth().getPersonId(owner)));

				const move = async () => {
					const stamp = String(await auth().emailChangeStamp(owner));
					expect(await auth().confirmEmailChange(owner, movedTo, stamp)).toBe(
						"changed",
					);
				};
				const squat = async () => {
					const made = await squatter(
						`${API}/mailboxes`,
						post({ email: address, name: "x" }),
					);
					expect(made.status).toBe(201);
				};
				const { env: paused, ran } = pausedAt(
					moveAt === squatAt
						? {
								[moveAt]: async () => {
									await move();
									await squat();
								},
							}
						: { [moveAt]: move, [squatAt]: squat },
				);
				await forgot(address, paused);
				moved = ran.includes(moveAt);
				if (!ran.includes(squatAt)) break;
				const pair = `moved at call ${moveAt}, mailbox made at call ${squatAt}`;
				tried.push(pair);

				// Whatever reached the mailbox, no link in it resets anything.
				const listed = await env.BUCKET.list({ prefix: "recovery-tokens/" });
				for (const object of listed.objects) {
					const stored = await env.BUCKET.get(object.key);
					if ((await stored?.json<{ userId: string }>())?.userId !== owner) {
						continue;
					}
					const token = object.key
						.replace("recovery-tokens/", "")
						.replace(".json", "");
					const used = await SELF.fetch(
						`${API}/auth/reset-password`,
						post({ token, newPassword: "taken-over-1" }),
					);
					expect(used.status, pair).toBe(401);
				}
				expect(await signIn(movedTo)).toBeTruthy();
			}
			if (!moved) break;
		}
		// The reset asks the auth object at least twice, before its link is
		// bound and after, so at least these were tried. A move before the
		// link is bound ends the reset there, with no later call for the
		// mailbox to be made at.
		expect(tried).toEqual(
			expect.arrayContaining([
				"moved at call 0, mailbox made at call 0",
				"moved at call 1, mailbox made at call 1",
			]),
		);
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

	it("does not run again on every cold isolate after passing over everything it found", async () => {
		const { at, root, people } = await setUp();
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
		// The only mailbox nobody holds is at somebody else's sign-in
		// address, so the old person is left holding nothing -- which, with
		// logins, is also what the marker's override reads as mail gone
		// missing.
		await env.BUCKET.put(`mailboxes/${people.victim.address}.json`, "{}");
		await env.BUCKET.delete(MARKER_KEY);
		resetLegacyGrantMemo();

		expect(await ensureLegacyMailboxGrants(env)).toMatchObject({
			ran: true,
			mailboxes: 1,
			granted: 0,
		});
		for (const isolate of [2, 3]) {
			resetLegacyGrantMemo();
			expect(
				(await ensureLegacyMailboxGrants(env)).ran,
				`cold isolate ${isolate}`,
			).toBe(false);
		}

		// Narrow: mail that went missing after a run that did grant is still
		// put back, which is what the override is for.
		await env.BUCKET.put(`mailboxes/${at("legacy-box")}.json`, "{}");
		await env.BUCKET.delete(MARKER_KEY);
		resetLegacyGrantMemo();
		expect(await ensureLegacyMailboxGrants(env)).toMatchObject({
			ran: true,
			granted: 1,
		});
		await runInDurableObject(auth(), async (_i, state) => {
			state.storage.sql.exec(
				"DELETE FROM person_mailboxes WHERE person_id = ?",
				LEGACY_ADMIN_PERSON_ID,
			);
		});
		resetLegacyGrantMemo();
		expect(await ensureLegacyMailboxGrants(env)).toMatchObject({
			ran: true,
			granted: 1,
		});
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
