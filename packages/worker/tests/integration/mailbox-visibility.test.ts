import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * Who sees which mailbox.
 *
 * One rule, and it is the whole of it: **an account sees the addresses it
 * registered, and nothing else.** Nobody assigns them. Registering an address
 * is what connects it to an account.
 *
 * Until now an administrator saw every mailbox on the deployment, which is
 * what turned two people sharing a deployment into two people reading each
 * other's mail. These assertions are what keeps that from coming back.
 */

const PW = "password123";

async function register(email: string) {
	return SELF.fetch("http://local.test/api/v1/auth/register", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email, password: PW }),
	});
}

async function signIn(email: string) {
	const res = await SELF.fetch("http://local.test/api/v1/auth/login", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email, password: PW }),
	});
	return res.json<{ id: string; userId: string }>();
}

function as(token: string) {
	return (url: string, options: RequestInit = {}) =>
		SELF.fetch(url, {
			...options,
			headers: { ...options.headers, Authorization: `Bearer ${token}` },
		});
}

/** Root makes the accounts; that is the only way one comes about. */
async function createAccount(rootToken: string, email: string) {
	const res = await as(rootToken)("http://local.test/api/v1/root/accounts", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email, password: PW }),
	});
	expect(res.status, `creating ${email}`).toBe(201);
}

async function registerMailbox(token: string, address: string) {
	const res = await as(token)("http://local.test/api/v1/mailboxes", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email: address, name: address }),
	});
	expect(res.status, `registering ${address}`).toBe(201);
}

async function visible(token: string): Promise<string[]> {
	const res = await as(token)("http://local.test/api/v1/mailboxes");
	expect(res.status).toBe(200);
	return (await res.json<{ id: string }[]>()).map((m) => m.id).sort();
}

describe("two people on one deployment", () => {
	let a: string;
	let b: string;

	beforeEach(async () => {
		// The first account to register is root; root then makes the two
		// accounts that actually use the mail.
		await register("root@example.com");
		const rootSession = await signIn("root@example.com");
		await createAccount(rootSession.id, "a@example.com");
		await createAccount(rootSession.id, "b@example.com");
		a = (await signIn("a@example.com")).id;
		b = (await signIn("b@example.com")).id;
	});

	it("shows each of them only what they registered", async () => {
		await registerMailbox(a, "info@example.com");
		await registerMailbox(a, "uota@example.com");
		await registerMailbox(b, "sales@example.com");

		expect(await visible(a)).toEqual([
			"info@example.com",
			"uota@example.com",
		]);
		expect(await visible(b)).toEqual(["sales@example.com"]);
	});

	/**
	 * Not merely absent from the list: unreachable. A list that hides a
	 * mailbox while the endpoint behind it still answers is not privacy, it
	 * is a tidier screen.
	 */
	it("refuses the other one's mailbox to anyone who asks directly", async () => {
		await registerMailbox(a, "info@example.com");

		for (const path of [
			"http://local.test/api/v1/mailboxes/info@example.com",
			"http://local.test/api/v1/mailboxes/info@example.com/emails",
			"http://local.test/api/v1/mailboxes/info@example.com/backups",
		]) {
			expect((await as(b)(path)).status, path).toBe(403);
		}
	});

	// The account that registered it still reaches it, which is the other
	// half of the same rule.
	it("lets the one who registered it through", async () => {
		await registerMailbox(a, "info@example.com");
		expect(
			(await as(a)("http://local.test/api/v1/mailboxes/info@example.com"))
				.status,
		).toBe(200);
	});

	/**
	 * Being an administrator is not a way in. This is the exception that was
	 * removed, asserted directly: b is made an administrator and still sees
	 * nothing of a's.
	 */
	it("does not let an administrator see the rest", async () => {
		await registerMailbox(a, "info@example.com");

		const rootSession = await signIn("root@example.com");
		const accounts = await (
			await as(rootSession.id)("http://local.test/api/v1/root/accounts")
		).json<{ id: string; email: string }[]>();
		const bId = accounts.find((x) => x.email === "b@example.com")?.id;
		await as(rootSession.id)(
			`http://local.test/api/v1/auth/admin/users/${bId}`,
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ isAdmin: true }),
			},
		);

		const asAdmin = await signIn("b@example.com");
		expect(await visible(asAdmin.id)).toEqual([]);
		expect(
			(
				await as(asAdmin.id)(
					"http://local.test/api/v1/mailboxes/info@example.com",
				)
			).status,
		).toBe(403);
	});

	// Root manages accounts and reads no mail, so it sees none of this.
	it("shows root nothing at all", async () => {
		await registerMailbox(a, "info@example.com");
		const rootSession = await signIn("root@example.com");
		expect(await visible(rootSession.id)).toEqual([]);
	});
});
