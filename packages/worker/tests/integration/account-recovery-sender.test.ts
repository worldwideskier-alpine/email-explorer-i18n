import { createExecutionContext, env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { recoveryFromEmail } from "../../src/deployment-config";

/**
 * Where the "forgot password" flow gets its sender.
 *
 * It was a string in dev/index.ts, which every fork inherited: a fork that
 * set nothing sent its resets as this deployment's address, on a domain its
 * Resend account cannot send from, and they never arrived. It is set on
 * /root now and kept in the bucket; the deployment's ACCOUNT_RECOVERY_FROM
 * variable, when set, still wins.
 *
 * Getting it wrong is quiet. The flow answers the same way whether it sent
 * anything or not, on purpose -- saying otherwise would tell a stranger which
 * addresses have accounts -- so a broken resolution shows up nowhere until
 * somebody needs it.
 */

const settings = async () =>
	(
		await (
			await SELF.fetch("http://local.test/api/v1/settings")
		).json<{
			accountRecovery: { enabled: boolean };
		}>()
	).accountRecovery.enabled;

const forgotPassword = (email: string) =>
	SELF.fetch("http://local.test/api/v1/auth/forgot-password", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email }),
	});

/** Root, signed in: the first account registered. */
async function root(): Promise<string> {
	await SELF.fetch("http://local.test/api/v1/auth/register", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email: "op@example.com", password: "password123" }),
	});
	const login = await SELF.fetch("http://local.test/api/v1/auth/login", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email: "op@example.com", password: "password123" }),
	});
	return (await login.json<{ id: string }>()).id;
}

const setSender = (token: string, fromEmail: string) =>
	SELF.fetch("http://local.test/api/v1/root/settings/account-recovery", {
		method: "PUT",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
		},
		body: JSON.stringify({ fromEmail }),
	});

// No fixture account: root is whoever registers first, as on a new deployment.
describe("the password-reset sender", () => {
	/** Nothing in the source names one, so a new deployment starts with it off. */
	it("is off until somebody sets one", async () => {
		expect(await settings()).toBe(false);
		expect((await forgotPassword("test@example.com")).status).toBe(503);
	});

	it("is set by root on /root, and turns the flow on", async () => {
		const token = await root();
		const saved = await setSender(token, " NoReply@Example.com ");
		expect(saved.status).toBe(200);
		expect(await saved.json()).toEqual({
			fromEmail: "noreply@example.com",
			setByDeployment: false,
			enabled: true,
		});
		expect(await settings()).toBe(true);
		expect((await forgotPassword("nobody@example.com")).status).not.toBe(503);
	});

	/**
	 * The same answer for an address with an account as for one without.
	 * Both sides have to be real: this used to compare two addresses neither
	 * of which had an account, which is one answer asked twice.
	 */
	it("answers a known address as it answers an unknown one", async () => {
		const token = await root();
		await setSender(token, "noreply@example.com");

		const known = await forgotPassword("op@example.com");
		// The known side really went down the known path: a reset was issued.
		const issued = await env.BUCKET.list({ prefix: "recovery-tokens/" });
		expect(issued.objects).toHaveLength(1);
		const unknown = await forgotPassword("nobody@example.com");
		expect(
			(await env.BUCKET.list({ prefix: "recovery-tokens/" })).objects,
		).toHaveLength(1);

		expect([unknown.status, await unknown.json()]).toEqual([
			known.status,
			await known.json(),
		]);
	});

	it("is turned off again by clearing it", async () => {
		const token = await root();
		await setSender(token, "noreply@example.com");
		expect((await setSender(token, "")).status).toBe(200);
		expect(await settings()).toBe(false);
	});

	it("is refused when it is not an address", async () => {
		const token = await root();
		expect((await setSender(token, "not an address")).status).toBe(400);
		expect(await settings()).toBe(false);
	});

	/**
	 * The variable is set per deployment, in GitHub, by whoever runs it; it
	 * wins over the screen. A blank one -- which is what an unset variable
	 * arrives as -- does not.
	 */
	it("gives way to the deployment's own variable, but not to a blank one", async () => {
		const token = await root();
		await setSender(token, "screen@example.com");
		expect(await recoveryFromEmail(env as never)).toBe("screen@example.com");
		expect(
			await recoveryFromEmail({
				...env,
				ACCOUNT_RECOVERY_FROM: "variable@example.com",
			} as never),
		).toBe("variable@example.com");
		expect(
			await recoveryFromEmail({
				...env,
				ACCOUNT_RECOVERY_FROM: "  ",
			} as never),
		).toBe("screen@example.com");

		const worker = await import("../../dev/index");
		const state = await worker.default.fetch(
			new Request("http://local.test/api/v1/root/settings/account-recovery", {
				headers: { Authorization: `Bearer ${token}` },
			}),
			{ ...env, ACCOUNT_RECOVERY_FROM: "variable@example.com" },
			createExecutionContext(),
		);
		expect(await state.json()).toMatchObject({ setByDeployment: true });
	});
});
