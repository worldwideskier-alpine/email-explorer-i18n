import { env, runInDurableObject, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { resetLegacyGrantMemo } from "../../src/legacy-grants";
import { LEGACY_ADMIN_PERSON_ID } from "../../src/people";
import { createMailbox, mailboxId } from "./utils";

/**
 * A mailbox in the state this section is named after: present in the bucket,
 * with no owner row behind it.
 *
 * `createMailbox` from utils grants it to the fixture person, which is a
 * mailbox that already belongs to somebody -- the opposite of what predates
 * the grant model. Using it here meant the test below asserted that the
 * backfill takes a mailbox belonging to another person, which is a hole
 * rather than a requirement, and it kept that hole from being noticed.
 */
async function createUnownedMailbox() {
	await env.BUCKET.put(`mailboxes/${mailboxId}.json`, JSON.stringify({}));
}

/**
 * The account tier above the mailboxes, and the migration into it.
 *
 * Two things are being held at once here. One is that root can manage
 * accounts and nobody else can. The other -- the one that decides whether
 * this is safe to deploy onto a live mailbox -- is that **nothing an
 * administrator can reach today stops working**. The business's mail is in
 * info@ and uota@; a change that makes those unreachable for an afternoon is
 * not a change worth having.
 */

async function register(email: string, password: string) {
	const res = await SELF.fetch("http://local.test/api/v1/auth/register", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email, password }),
	});
	return res;
}

/** Registration closes behind the first account, so the rest are made directly. */
async function createUser(
	email: string,
	isAdmin: boolean,
	personId?: string,
): Promise<string> {
	const stub = env.MAILBOX.get(env.MAILBOX.idFromName("AUTH"));
	const user = await stub.register(email, "password123", isAdmin, personId);
	return user.id;
}

async function signIn(email: string, password = "password123") {
	const res = await SELF.fetch("http://local.test/api/v1/auth/login", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email, password }),
	});
	return res.json<{ id: string; role?: string }>();
}

function as(token: string) {
	return (url: string, options: RequestInit = {}) =>
		SELF.fetch(url, {
			...options,
			headers: { ...options.headers, Authorization: `Bearer ${token}` },
		});
}

describe("who may reach the account list", () => {
	beforeEach(() => {
		resetLegacyGrantMemo();
	});

	it("refuses an administrator who is not root", async () => {
		await register("operator@example.com", "password123");
		const other = await createUser("other@example.com", true);
		expect(other).toBeTruthy();
		const otherSession = await signIn("other@example.com");
		expect(
			(await as(otherSession.id)("http://local.test/api/v1/root/accounts"))
				.status,
		).toBe(403);
	});

	it("refuses it to nobody at all", async () => {
		const res = await SELF.fetch("http://local.test/api/v1/root/accounts");
		expect(res.status).toBe(401);
	});
});

describe("what root does with accounts", () => {
	let root: string;

	beforeEach(async () => {
		resetLegacyGrantMemo();
		await register("operator@example.com", "password123");
		root = (await signIn("operator@example.com")).id;
	});

	it("creates an account, and it can sign in", async () => {
		const created = await as(root)("http://local.test/api/v1/root/accounts", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				email: "hanako@example.com",
				password: "password123",
			}),
		});
		expect(created.status).toBe(201);
		expect((await signIn("hanako@example.com")).role).toBe("admin");
	});

	it("will not create the same address twice", async () => {
		const body = JSON.stringify({
			email: "hanako@example.com",
			password: "password123",
		});
		const headers = { "Content-Type": "application/json" };
		await as(root)("http://local.test/api/v1/root/accounts", {
			method: "POST",
			headers,
			body,
		});
		const again = await as(root)("http://local.test/api/v1/root/accounts", {
			method: "POST",
			headers,
			body,
		});
		expect(again.status).toBe(400);
	});

	/**
	 * What makes an in-system address usable as a login: somebody whose
	 * recovery mail lands in a mailbox they cannot open until they sign in is
	 * otherwise locked out for good.
	 */
	it("sets a password without being told the old one", async () => {
		const userId = await createUser("hanako@example.com", true);
		const res = await as(root)(
			`http://local.test/api/v1/root/accounts/${userId}/password`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ password: "brand-new-password" }),
			},
		);
		expect(res.status).toBe(200);
		expect(
			(await signIn("hanako@example.com", "brand-new-password")).id,
		).toBeTruthy();
	});

	// A reset that leaves the old sessions alive resets nothing.
	it("drops the account's existing sessions when the password changes", async () => {
		const userId = await createUser("hanako@example.com", true);
		const before = await signIn("hanako@example.com");
		expect(
			(await as(before.id)("http://local.test/api/v1/mailboxes")).status,
		).toBe(200);

		await as(root)(
			`http://local.test/api/v1/root/accounts/${userId}/password`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ password: "brand-new-password" }),
			},
		);

		expect(
			(await as(before.id)("http://local.test/api/v1/mailboxes")).status,
		).toBe(401);
	});

	/** Root manages people, so the thing it deletes is a person. */
	async function personIdOf(email: string): Promise<string> {
		const people = await (
			await as(root)("http://local.test/api/v1/root/accounts")
		).json<{ personId: string; emails: string[] }[]>();
		const found = people.find((p) => p.emails.includes(email));
		expect(found).toBeDefined();
		return (found as { personId: string }).personId;
	}

	it("deletes a person, and none of their logins can sign in", async () => {
		await createUser("leaver@example.com", false);
		await createUser(
			"leaver-spare@example.com",
			false,
			await personIdOf("leaver@example.com"),
		);

		const res = await as(root)(
			`http://local.test/api/v1/root/accounts/${await personIdOf("leaver@example.com")}`,
			{ method: "DELETE" },
		);
		expect(res.status).toBe(200);

		for (const email of ["leaver@example.com", "leaver-spare@example.com"]) {
			const attempt = await SELF.fetch("http://local.test/api/v1/auth/login", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ email, password: "password123" }),
			});
			expect(attempt.status).not.toBe(200);
		}
	});

	/**
	 * Deleting means deleting.
	 *
	 * This used to keep the mailbox, on the reasoning that mail outlives
	 * whoever read it. Between colleagues that is right; here root runs the
	 * deployment and the people below are its customers, and a deletion that
	 * leaves their mail in the bucket has stopped nothing: it still costs, it
	 * is still readable from the Cloudflare account, and no screen says it is
	 * there. Half a deletion looks finished and is not.
	 */
	it("takes the mailboxes, and the archives, with the person", async () => {
		const bucket = (env as unknown as { BUCKET: R2Bucket }).BUCKET;

		const leaverId = await createUser("leaver@example.com", false);
		const leaver = await signIn("leaver@example.com");
		expect(leaverId).toBeTruthy();
		const made = await as(leaver.id)("http://local.test/api/v1/mailboxes", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: mailboxId, name: "Theirs" }),
		});
		expect(made.status).toBe(201);
		await bucket.put(
			`backups/${encodeURIComponent(mailboxId)}/2026-01-01.mbox`,
			"archived",
		);

		await as(root)(
			`http://local.test/api/v1/root/accounts/${await personIdOf("leaver@example.com")}`,
			{ method: "DELETE" },
		);

		expect(await bucket.head(`mailboxes/${mailboxId}.json`)).toBeNull();
		const archives = await bucket.list({
			prefix: `backups/${encodeURIComponent(mailboxId)}/`,
		});
		expect(archives.objects).toEqual([]);
	});

	/**
	 * The lock keeps an administrator from destroying their own mailbox by
	 * mis-clicking. It is not a defence against the person running the
	 * deployment, and an account that cannot be deleted because of a checkbox
	 * its own owner ticked is not an account anybody can stop serving.
	 */
	it("is not stopped by the mailbox's deletion lock", async () => {
		const bucket = (env as unknown as { BUCKET: R2Bucket }).BUCKET;

		await createUser("leaver@example.com", false);
		const leaver = await signIn("leaver@example.com");
		await as(leaver.id)("http://local.test/api/v1/mailboxes", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: mailboxId, name: "Theirs" }),
		});
		// The default, stated here so the test does not rest on it silently.
		const settings = await (
			await bucket.get(`mailboxes/${mailboxId}.json`)
		)?.json<{ deletionLocked?: boolean }>();
		expect(settings?.deletionLocked).toBe(true);

		await as(root)(
			`http://local.test/api/v1/root/accounts/${await personIdOf("leaver@example.com")}`,
			{ method: "DELETE" },
		);
		expect(await bucket.head(`mailboxes/${mailboxId}.json`)).toBeNull();
	});

	it("will not delete itself", async () => {
		const res = await as(root)(
			`http://local.test/api/v1/root/accounts/${await personIdOf("operator@example.com")}`,
			{ method: "DELETE" },
		);
		expect(res.status).toBe(409);
	});
});

/**
 * The migration, and the reason it exists.
 *
 * An administrator saw every mailbox by skipping the access check, so the
 * mailboxes actually in use had no grant rows at all. Remove that skip with
 * nothing in their place and every mailbox vanishes from every screen at
 * once. The backfill writes the rows first, while the skip is still there and
 * nothing depends on them.
 */
describe("mailboxes that predate the grant model", () => {
	beforeEach(() => {
		resetLegacyGrantMemo();
	});

	/**
	 * The subject is a login the migration folded into the deployment's
	 * original person, which is what "was already here" means now. It used to
	 * be "carries the admin flag", read at the moment the backfill happened to
	 * run -- and that moment can be days after the deploy, by which time a
	 * second person may have been given an account and the flag with it. The
	 * person is fixed when the migration runs; the flag is not.
	 */
	it("gives the deployment's original person an explicit ownership row", async () => {
		await register("first@example.com", "password123");
		const adminId = await createUser(
			"admin@example.com",
			true,
			LEGACY_ADMIN_PERSON_ID,
		);
		const firstSession = await signIn("admin@example.com");
		await createUnownedMailbox();

		// The screen where a missing grant would first show. Asking for it is
		// what runs the backfill.
		expect(
			(await as(firstSession.id)("http://local.test/api/v1/mailboxes")).status,
		).toBe(200);

		const stub = env.MAILBOX.get(env.MAILBOX.idFromName("AUTH"));
		await runInDurableObject(stub, async (instance) => {
			const owned = await (
				instance as unknown as {
					getPersonMailboxes(id: string): Promise<string[]>;
				}
			).getPersonMailboxes(adminId);
			expect(owned).toContain(mailboxId);
		});
	});

	/**
	 * The window this closes: the backfill runs from whichever request lands
	 * first after the deploy, and nothing says that is soon. A second person
	 * given an account and the admin flag in between must not be swept into
	 * the deployment's original person and handed every mailbox in it -- as
	 * an owner, permanently, in rows indistinguishable from the real ones.
	 *
	 * The set is named by the migration, so an account made afterwards has a
	 * person of its own and cannot fall into it however its flag is set.
	 */
	it("does not hand the estate to somebody who became an administrator later", async () => {
		await register("first@example.com", "password123");
		await createUser("first-spare@example.com", true, LEGACY_ADMIN_PERSON_ID);
		await createMailbox();

		// A second person, made an administrator so they can keep their own
		// addresses, before the backfill has had a chance to run.
		const latecomer = await createUser("second-person@example.com", true);
		const theirSession = await signIn("second-person@example.com");

		// Their first request is the one that runs the backfill.
		expect(
			(await as(theirSession.id)("http://local.test/api/v1/mailboxes")).status,
		).toBe(200);

		const stub = env.MAILBOX.get(env.MAILBOX.idFromName("AUTH"));
		await runInDurableObject(stub, async (instance) => {
			const owned = await (
				instance as unknown as {
					getPersonMailboxes(id: string): Promise<string[]>;
				}
			).getPersonMailboxes(latecomer);
			expect(owned).toEqual([]);
		});
	});

	/**
	 * Root manages accounts; it does not inherit the estate. Here the same
	 * account was an administrator first and then became root, so the
	 * backfill has to have skipped it.
	 */
	it("does not give the existing mailboxes to root", async () => {
		await register("operator@example.com", "password123");
		const rootSession = await signIn("operator@example.com");
		await createMailbox();
		await as(rootSession.id)("http://local.test/api/v1/mailboxes");

		const stub = env.MAILBOX.get(env.MAILBOX.idFromName("AUTH"));
		const me = await (
			await as(rootSession.id)("http://local.test/api/v1/auth/me")
		).json<{ userId: string }>();
		await runInDurableObject(stub, async (instance) => {
			const owned = await (
				instance as unknown as {
					getPersonMailboxes(id: string): Promise<string[]>;
				}
			).getPersonMailboxes(me.userId);
			expect(owned).toEqual([]);
		});
	});

	/**
	 * Once, not as a rule. Repeating it would mean every administrator owning
	 * every mailbox for ever, which is the arrangement being moved away from:
	 * a mailbox made after this belongs to whoever made it.
	 */
	it("does not adopt mailboxes made after it ran", async () => {
		await register("first@example.com", "password123");
		const firstSession = await signIn("first@example.com");
		await createMailbox();
		await as(firstSession.id)("http://local.test/api/v1/mailboxes");

		const laterAdmin = await createUser("later@example.com", true);
		resetLegacyGrantMemo();
		await as(firstSession.id)("http://local.test/api/v1/mailboxes");

		const stub = env.MAILBOX.get(env.MAILBOX.idFromName("AUTH"));
		await runInDurableObject(stub, async (instance) => {
			const owned = await (
				instance as unknown as {
					getPersonMailboxes(id: string): Promise<string[]>;
				}
			).getPersonMailboxes(laterAdmin);
			expect(owned).toEqual([]);
		});
	});
});

/**
 * The other half of the same promise: a mailbox made from now on belongs to
 * whoever made it, so it does not disappear the moment the administrator
 * bypass is removed.
 */
describe("a mailbox made today", () => {
	beforeEach(() => {
		resetLegacyGrantMemo();
	});

	it("belongs to whoever created it", async () => {
		await register("first@example.com", "password123");
		const session = await signIn("first@example.com");
		const me = await (
			await as(session.id)("http://local.test/api/v1/auth/me")
		).json<{ userId: string }>();

		await as(session.id)("http://local.test/api/v1/mailboxes", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: "brand-new@example.com", name: "New" }),
		});

		const stub = env.MAILBOX.get(env.MAILBOX.idFromName("AUTH"));
		await runInDurableObject(stub, async (instance) => {
			const owned = await (
				instance as unknown as {
					getPersonMailboxes(id: string): Promise<string[]>;
				}
			).getPersonMailboxes(me.userId);
			expect(owned).toContain("brand-new@example.com");
		});
	});
});

describe("the first account", () => {
	beforeEach(() => {
		resetLegacyGrantMemo();
	});

	/**
	 * Step one of the only flow there is: root, then the administrators root
	 * makes, then the mailboxes those administrators make.
	 */
	it("is root, without anyone having to ask for it", async () => {
		await register("first@example.com", "password123");
		expect((await signIn("first@example.com")).role).toBe("root");
	});

	it("is the only account that gets it", async () => {
		await register("first@example.com", "password123");
		await createUser("second@example.com", true);
		expect((await signIn("second@example.com")).role).toBe("admin");
	});

	/**
	 * There is no route that names a root. An endpoint for it, however well
	 * guarded, would read as "somebody may take the tier above them" on every
	 * deployment of this that exists -- and this is software people fork and
	 * put on the public internet.
	 */
	it("cannot be named over HTTP at all", async () => {
		await register("first@example.com", "password123");
		const session = await signIn("first@example.com");

		for (const path of [
			"/api/v1/auth/admin/claim-root",
			"/api/v1/auth/admin/root",
		]) {
			const res = await as(session.id)(`http://local.test${path}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ userId: "anyone" }),
			});
			expect(res.status, path).toBe(404);
		}
	});

	// Root manages accounts. The estate is not its to look at.
	it("does not see the mailboxes", async () => {
		await register("first@example.com", "password123");
		const session = await signIn("first@example.com");
		await createMailbox();

		const listed = await as(session.id)("http://local.test/api/v1/mailboxes");
		expect(await listed.json<unknown[]>()).toEqual([]);
	});
});

/*
 * Root is no longer handed to anybody, and there is no route that could.
 *
 * It used to be the handover path and the recovery path at once. It had to
 * go: this is software somebody sells, and root's job is making and unmaking
 * the accounts of the people who pay for it. A button that hands that to one
 * of them is a button nobody wants to own, however carefully guarded, and its
 * presence is the thing that is wrong -- not its guard.
 *
 * What replaces it is that the role belongs to a person rather than to one
 * login, so root adds a spare address the same way anybody else does and the
 * role survives losing the first. See "the first account" above for the role
 * following the person, and own-logins.test.ts for adding a spare.
 */

/**
 * The one form on the root screen, and the two different things it does.
 *
 * "administrator" puts somebody new in the deployment. "super administrator"
 * adds another address to root's own account -- a spare, not a second holder
 * of the role. The distinction is the whole reason this is safe: a second
 * person holding root is a second person who can delete everybody, which is
 * exactly what removing the transfer button was for. Getting it wrong looks
 * identical on the screen and is the opposite thing.
 */
describe("what root's create form makes", () => {
	let root: string;

	beforeEach(async () => {
		resetLegacyGrantMemo();
		await register("operator@example.com", "password123");
		root = (await signIn("operator@example.com")).id;
	});

	const create = (email: string, role: "root" | "admin") =>
		as(root)("http://local.test/api/v1/root/accounts", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email, password: "password123", role }),
		});

	const people = async () =>
		(
			await (
				await as(root)("http://local.test/api/v1/root/accounts")
			).json<{ personId: string; emails: string[]; role: string }[]>()
		).sort((a, b) => a.emails[0].localeCompare(b.emails[0]));

	it("adds a spare to root's own account, not a second root", async () => {
		expect((await create("operator-spare@example.com", "root")).status).toBe(
			201,
		);

		const listed = await people();
		// One person, both addresses, still the only root there is.
		expect(listed).toHaveLength(1);
		expect(listed[0].emails.sort()).toEqual([
			"operator-spare@example.com",
			"operator@example.com",
		]);
		expect(listed.filter((p) => p.role === "root")).toHaveLength(1);
	});

	// And the spare really is root: signing in with it reaches the screen.
	it("gives the spare the role, so losing the first address loses nothing", async () => {
		await create("operator-spare@example.com", "root");
		const spare = await signIn("operator-spare@example.com");
		expect(spare.role).toBe("root");
		expect(
			(await as(spare.id)("http://local.test/api/v1/root/accounts")).status,
		).toBe(200);
	});

	it("makes a separate person for an administrator", async () => {
		expect((await create("hanako@example.com", "admin")).status).toBe(201);

		const listed = await people();
		expect(listed).toHaveLength(2);
		expect(listed.filter((p) => p.role === "root")).toHaveLength(1);
		expect(
			listed.find((p) => p.emails.includes("hanako@example.com"))?.role,
		).toBe("admin");
	});

	// Which is to say: the two options are not two labels on one act.
	it("keeps the two apart", async () => {
		await create("operator-spare@example.com", "root");
		await create("hanako@example.com", "admin");

		const listed = await people();
		const rootPerson = listed.find((p) => p.role === "root");
		expect(rootPerson?.emails.sort()).toEqual([
			"operator-spare@example.com",
			"operator@example.com",
		]);
		expect(rootPerson?.emails).not.toContain("hanako@example.com");
	});
});

/**
 * The one state that overrides the "already done" marker.
 *
 * The claim on a mailbox is now the only thing that makes it visible. If the
 * deployment's original person somehow holds none while mailboxes exist, the
 * mail has vanished from every screen while continuing to arrive -- and the
 * marker stops the one piece of code that could put the rows back, so there
 * is no way out from inside the application.
 *
 * This is the safety net for exactly that, and it is narrow on purpose:
 * repeating the backfill in any other circumstance is the thing that must not
 * happen.
 */
describe("mail that has lost its owner", () => {
	beforeEach(() => {
		resetLegacyGrantMemo();
	});

	it("gives it back to the deployment's original person", async () => {
		await register("first@example.com", "password123");
		const legacy = await createUser(
			"legacy@example.com",
			true,
			LEGACY_ADMIN_PERSON_ID,
		);
		const session = await signIn("legacy@example.com");
		await createMailbox();

		// The backfill runs and records that it has.
		expect(
			(await as(session.id)("http://local.test/api/v1/mailboxes")).status,
		).toBe(200);

		// Now the claims are gone but the mailbox is not -- the state that
		// would otherwise be permanent.
		const stub = env.MAILBOX.get(env.MAILBOX.idFromName("AUTH"));
		await runInDurableObject(stub, async (_instance, state) => {
			state.storage.sql.exec("DELETE FROM person_mailboxes");
		});
		resetLegacyGrantMemo();

		const listed = await (
			await as(session.id)("http://local.test/api/v1/mailboxes")
		).json<Array<{ id: string }>>();
		expect(listed.map((m) => m.id)).toContain(mailboxId);
		expect(legacy).toBeTruthy();
	});

	/**
	 * And it stays a one-time backfill everywhere else. Widening it to "run
	 * whenever the marker exists" would hand the original person every
	 * mailbox in the deployment again, every time -- including ones made
	 * afterwards by somebody else, which is the arrangement being moved away
	 * from.
	 */
	it("leaves a person who still holds theirs exactly as they are", async () => {
		await register("first@example.com", "password123");
		const legacy = await createUser(
			"legacy@example.com",
			true,
			LEGACY_ADMIN_PERSON_ID,
		);
		expect(legacy).toBeTruthy();
		const session = await signIn("legacy@example.com");

		// One mailbox they registered, so they hold something.
		const made = await as(session.id)("http://local.test/api/v1/mailboxes", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: "mine@example.com", name: "Mine" }),
		});
		expect(made.status).toBe(201);

		// The backfill runs once and records it.
		expect(
			(await as(session.id)("http://local.test/api/v1/mailboxes")).status,
		).toBe(200);

		// Then somebody else's mailbox appears, claimed by nobody they know.
		await createMailbox();
		resetLegacyGrantMemo();

		const listed = await (
			await as(session.id)("http://local.test/api/v1/mailboxes")
		).json<Array<{ id: string }>>();
		expect(listed.map((m) => m.id)).toEqual(["mine@example.com"]);
	});
});
