import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { testAuthBeforeAll } from "./utils";

/**
 * What the sign-in page asks before anybody is signed in: whether the first
 * registration is open. It used to fetch every login's address from the auth
 * object to count them; it asks whether there is one.
 */
const settings = async () =>
	(await SELF.fetch("http://local.test/api/v1/settings")).json<{
		auth: { registerEnabled: boolean };
	}>();

describe("the public settings", () => {
	it("open the first registration on a deployment with nobody in it", async () => {
		expect((await settings()).auth.registerEnabled).toBe(true);
	});

	it("close it once somebody has registered", async () => {
		await testAuthBeforeAll();
		expect((await settings()).auth.registerEnabled).toBe(false);
	});
});
