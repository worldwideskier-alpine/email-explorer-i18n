import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { testAuthBeforeAll } from "./utils";

/**
 * That account recovery is still switched on for THIS deployment.
 *
 * The from-address moved from being read straight off
 * `config.accountRecovery` to being resolved -- environment variable first,
 * then the `EmailExplorer({ accountRecovery })` option -- so that a fork can
 * set its own without editing source. This deployment sets the option in
 * dev/index.ts and leaves the variable blank, which is the case that has to
 * keep working.
 *
 * Getting it wrong is quiet. The "forgot password" flow answers the same way
 * whether it sent anything or not, on purpose: saying otherwise would tell a
 * stranger which addresses have accounts. So a resolution bug would not show
 * up as an error anywhere; recovery would simply stop, and nobody would find
 * out until they needed it.
 */

const settings = () => SELF.fetch("http://local.test/api/v1/settings");

const forgotPassword = (email: string) =>
	SELF.fetch("http://local.test/api/v1/auth/forgot-password", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email }),
	});

describe("account recovery on this deployment", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
	});

	// dev/wrangler.jsonc carries ACCOUNT_RECOVERY_FROM as an empty string so a
	// fork has somewhere to put its own address. Empty must not read as
	// "configured to nothing" and turn the flow off.
	it("is reported as available", async () => {
		const body = await (await settings()).json<{
			accountRecovery: { enabled: boolean };
		}>();
		expect(body.accountRecovery.enabled).toBe(true);
	});

	// 503 is the "no from-address anywhere" answer. Anything else means one
	// was found and the flow ran.
	it("does not refuse a reset request as unconfigured", async () => {
		expect((await forgotPassword("test@example.com")).status).not.toBe(503);
	});

	it("answers the same for an address with no account", async () => {
		const known = await forgotPassword("test@example.com");
		const unknown = await forgotPassword("nobody@example.com");
		expect(unknown.status).toBe(known.status);
	});
});
