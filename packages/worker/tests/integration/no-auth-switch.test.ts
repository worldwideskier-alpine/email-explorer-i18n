import { createExecutionContext, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { EmailExplorer } from "../../src";
import { createMailbox, mailboxId, testAuthBeforeAll } from "./utils";

/**
 * There is no switch that turns the gate off.
 *
 * `EmailExplorer({ auth: { enabled: false } })` used to skip the session
 * check on every route -- and with it the check that the caller holds the
 * mailbox, since that runs only once a session is known. Anybody who could
 * guess an address read that mailbox, deleted it, and sent as it. Mailbox
 * ownership left nothing for the mode to be useful for, so it is gone: the
 * option is not in the type, and a configuration that still passes it gets
 * the gate like every other.
 */

const worker = EmailExplorer({
	// @ts-expect-error -- not an option any more; see above.
	auth: { enabled: false },
});

const ask = (path: string, init: RequestInit = {}) =>
	worker.fetch(
		new Request(`http://local.test${path}`, init),
		env as never,
		createExecutionContext(),
	);

describe("a configuration that asks for no authentication", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createMailbox();
	});

	it("still refuses a mailbox to a caller with no session", async () => {
		const id = encodeURIComponent(mailboxId);
		for (const [path, method] of [
			[`/api/v1/mailboxes/${id}/emails?folder=inbox`, "GET"],
			[`/api/v1/mailboxes/${id}`, "DELETE"],
			["/api/v1/mailboxes", "GET"],
		] as const) {
			const res = await ask(path, { method });
			expect(res.status, `${method} ${path}`).toBe(401);
		}
	});

	it("still answers the public routes", async () => {
		const res = await ask("/api/v1/settings");
		expect(res.status).toBe(200);
		const body = await res.json<Record<string, unknown>>();
		// Nothing left to report: the gate is always there.
		expect(body.auth).not.toHaveProperty("enabled");
	});
});
