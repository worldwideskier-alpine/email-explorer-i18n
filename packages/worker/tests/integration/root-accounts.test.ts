import { env, runInDurableObject, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { resetLegacyGrantMemo } from "../../src/legacy-grants";
import { createMailbox, mailboxId } from "./utils";

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
async function createUser(email: string, isAdmin: boolean): Promise<string> {
	const stub = env.MAILBOX.get(env.MAILBOX.idFromName("AUTH"));
	const user = await stub.register(email, "password123", isAdmin);
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
			body: JSON.stringify({ email: "hanako@example.com", password: "password123" }),
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
		expect((await signIn("hanako@example.com", "brand-new-password")).id).toBeTruthy();
	});

	// A reset that leaves the old sessions alive resets nothing.
	it("drops the account's existing sessions when the password changes", async () => {
		const userId = await createUser("hanako@example.com", true);
		const before = await signIn("hanako@example.com");
		expect(
			(await as(before.id)("http://local.test/api/v1/mailboxes")).status,
		).toBe(200);

		await as(root)(`http://local.test/api/v1/root/accounts/${userId}/password`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ password: "brand-new-password" }),
		});

		expect(
			(await as(before.id)("http://local.test/api/v1/mailboxes")).status,
		).toBe(401);
	});

	it("deletes an account, and it can no longer sign in", async () => {
		await createUser("keeper@example.com", true);
		const userId = await createUser("leaver@example.com", true);

		const res = await as(root)(
			`http://local.test/api/v1/root/accounts/${userId}`,
			{ method: "DELETE" },
		);
		expect(res.status).toBe(204);

		const attempt = await SELF.fetch("http://local.test/api/v1/auth/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: "leaver@example.com", password: "password123" }),
		});
		expect(attempt.status).not.toBe(200);
	});

	/**
	 * Deleting a person must not delete the mail. The addresses outlive
	 * whoever was looking after them.
	 */
	it("leaves the mailbox behind when the account goes", async () => {
		await createMailbox();
		await createUser("keeper@example.com", true);
		const userId = await createUser("leaver@example.com", true);

		await as(root)(`http://local.test/api/v1/root/accounts/${userId}`, {
			method: "DELETE",
		});

		expect(
			await (env as unknown as { BUCKET: R2Bucket }).BUCKET.head(
				`mailboxes/${mailboxId}.json`,
			),
		).not.toBeNull();
	});

	it("will not delete itself", async () => {
		const accounts = await (
			await as(root)("http://local.test/api/v1/root/accounts")
		).json<{ id: string; role: string }[]>();
		const rootId = accounts.find((a) => a.role === "root")?.id;

		const res = await as(root)(
			`http://local.test/api/v1/root/accounts/${rootId}`,
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

	it("gives each existing administrator an explicit ownership row", async () => {
		await register("first@example.com", "password123");
		const adminId = await createUser("admin@example.com", true);
		const firstSession = await signIn("admin@example.com");
		await createMailbox();

		// The screen where a missing grant would first show. Asking for it is
		// what runs the backfill.
		expect(
			(await as(firstSession.id)("http://local.test/api/v1/mailboxes")).status,
		).toBe(200);

		const stub = env.MAILBOX.get(env.MAILBOX.idFromName("AUTH"));
		await runInDurableObject(stub, async (instance) => {
			const owned = await (
				instance as unknown as {
					getUserMailboxes(id: string): Promise<{ mailboxId: string }[]>;
				}
			).getUserMailboxes(adminId);
			expect(owned.map((entry) => entry.mailboxId)).toContain(mailboxId);
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
					getUserMailboxes(id: string): Promise<{ mailboxId: string }[]>;
				}
			).getUserMailboxes(me.userId);
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
					getUserMailboxes(id: string): Promise<{ mailboxId: string }[]>;
				}
			).getUserMailboxes(laterAdmin);
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
					getUserMailboxes(id: string): Promise<{ mailboxId: string }[]>;
				}
			).getUserMailboxes(me.userId);
			expect(owned.map((entry) => entry.mailboxId)).toContain(
				"brand-new@example.com",
			);
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

/**
 * Handing the role on. This is the handover path and the recovery path at
 * once, which is why it exists rather than being left to an edit of the
 * storage from the Cloudflare side.
 */
describe("handing root to somebody else", () => {
	let root: string;
	let rootUserId: string;

	beforeEach(async () => {
		resetLegacyGrantMemo();
		await register("first@example.com", "password123");
		const session = await signIn("first@example.com");
		rootUserId = (
			await (
				await as(session.id)("http://local.test/api/v1/auth/me")
			).json<{ userId: string }>()
		).userId;
		root = session.id;
	});

	it("moves the role, and the old holder loses the screen", async () => {
		const successor = await createUser("next@example.com", true);

		const res = await as(root)("http://local.test/api/v1/root/transfer", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ userId: successor }),
		});
		expect(res.status).toBe(200);

		expect((await signIn("next@example.com")).role).toBe("root");
		expect((await signIn("first@example.com")).role).toBe("admin");
		expect(
			(await as(root)("http://local.test/api/v1/root/accounts")).status,
		).toBe(403);
	});

	it("is refused to anyone who is not root", async () => {
		const other = await createUser("other@example.com", true);
		const otherSession = await signIn("other@example.com");
		const res = await as(otherSession.id)(
			"http://local.test/api/v1/root/transfer",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ userId: other }),
			},
		);
		expect(res.status).toBe(403);
	});

	it("refuses an account that does not exist", async () => {
		const res = await as(root)("http://local.test/api/v1/root/transfer", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ userId: "no-such-user" }),
		});
		expect(res.status).toBe(404);
	});
});
