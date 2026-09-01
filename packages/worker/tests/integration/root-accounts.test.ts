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

const ROOT_EMAIL = "operator+root@example.com";

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

describe("who root is", () => {
	beforeEach(() => {
		resetLegacyGrantMemo();
	});

	it("hands the role to the configured address at sign-in", async () => {
		await register(ROOT_EMAIL, "password123");
		expect((await signIn(ROOT_EMAIL)).role).toBe("root");
	});

	/**
	 * The address without the tag reaches the same real inbox, and that is
	 * exactly why it must not inherit the role.
	 */
	it("does not hand it to the same inbox without the tag", async () => {
		await register("operator@example.com", "password123");
		expect((await signIn("operator@example.com")).role).toBe("admin");
	});

	it("refuses the account list to an administrator who is not root", async () => {
		await register("operator@example.com", "password123");
		const session = await signIn("operator@example.com");
		const res = await as(session.id)("http://local.test/api/v1/root/accounts");
		expect(res.status).toBe(403);
	});

	it("refuses it to nobody at all", async () => {
		await register(ROOT_EMAIL, "password123");
		const res = await SELF.fetch("http://local.test/api/v1/root/accounts");
		expect(res.status).toBe(401);
	});
});

describe("what root does with accounts", () => {
	let root: string;

	beforeEach(async () => {
		resetLegacyGrantMemo();
		await register(ROOT_EMAIL, "password123");
		root = (await signIn(ROOT_EMAIL)).id;
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
	 * whoever was looking after them, and root reassigns them afterwards.
	 */
	it("leaves the mailbox behind when the account goes", async () => {
		await createMailbox();
		await createUser("keeper@example.com", true);
		const userId = await createUser("leaver@example.com", true);
		await as(root)(
			`http://local.test/api/v1/root/accounts/${userId}/mailboxes`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ mailboxId }),
			},
		);

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

	it("assigns a mailbox and takes it away again", async () => {
		await createMailbox();
		const userId = await createUser("hanako@example.com", true);

		await as(root)(
			`http://local.test/api/v1/root/accounts/${userId}/mailboxes`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ mailboxId }),
			},
		);
		let listed = await (
			await as(root)("http://local.test/api/v1/root/accounts")
		).json<{ id: string; mailboxes: string[] }[]>();
		expect(listed.find((a) => a.id === userId)?.mailboxes).toEqual([mailboxId]);

		await as(root)(
			`http://local.test/api/v1/root/accounts/${userId}/mailboxes/${mailboxId}`,
			{ method: "DELETE" },
		);
		listed = await (
			await as(root)("http://local.test/api/v1/root/accounts")
		).json<{ id: string; mailboxes: string[] }[]>();
		expect(listed.find((a) => a.id === userId)?.mailboxes).toEqual([]);
	});

	it("refuses to assign a mailbox that does not exist", async () => {
		const userId = await createUser("hanako@example.com", true);
		const res = await as(root)(
			`http://local.test/api/v1/root/accounts/${userId}/mailboxes`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ mailboxId: "typo@example.com" }),
			},
		);
		expect(res.status).toBe(404);
	});

	// Root manages accounts. It is not a second pair of eyes on the mail, and
	// nothing it can reach returns a message.
	it("owns no mailbox of its own", async () => {
		await createMailbox();
		const accounts = await (
			await as(root)("http://local.test/api/v1/root/accounts")
		).json<{ role: string; mailboxes: string[] }[]>();
		expect(accounts.find((a) => a.role === "root")?.mailboxes).toEqual([]);
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
		const firstSession = await signIn("first@example.com");
		await createMailbox();

		// The screen where a missing grant would first show. Asking for it is
		// what runs the backfill.
		expect(
			(await as(firstSession.id)("http://local.test/api/v1/mailboxes")).status,
		).toBe(200);

		const stub = env.MAILBOX.get(env.MAILBOX.idFromName("AUTH"));
		await runInDurableObject(stub, async (instance) => {
			const users = await (
				instance as unknown as { getUsers(): Promise<{ id: string }[]> }
			).getUsers();
			const owned = await (
				instance as unknown as {
					getUserMailboxes(id: string): Promise<{ mailboxId: string }[]>;
				}
			).getUserMailboxes(users[0]?.id ?? "");
			expect(owned.map((entry) => entry.mailboxId)).toContain(mailboxId);
		});
	});

	// Root manages accounts; it does not inherit the estate on its first day.
	it("does not hand the existing mailboxes to root", async () => {
		await register(ROOT_EMAIL, "password123");
		const rootSession = await signIn(ROOT_EMAIL);
		await createMailbox();
		await as(rootSession.id)("http://local.test/api/v1/mailboxes");

		const accounts = await (
			await as(rootSession.id)("http://local.test/api/v1/root/accounts")
		).json<{ role: string; mailboxes: string[] }[]>();
		expect(accounts.find((a) => a.role === "root")?.mailboxes).toEqual([]);
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
