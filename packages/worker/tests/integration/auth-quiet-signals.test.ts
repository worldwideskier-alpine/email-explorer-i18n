import {
	createExecutionContext,
	env,
	runInDurableObject,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailboxDO } from "../../src/durableObject";
import { sessionToken, testAuthBeforeAll } from "./utils";

/**
 * What an answer says without meaning to.
 */

afterEach(() => {
	vi.restoreAllMocks();
});

/**
 * A 401 is what the dashboard signs out on. The auth object not answering --
 * a deploy restarting it, a moment's trouble -- used to be answered 401 as
 * well, and signed out everybody who made a request just then.
 */
describe("a session the auth object could not check", () => {
	beforeEach(testAuthBeforeAll);

	it("is answered 503, not 401", async () => {
		const ns = env.MAILBOX;
		const unanswering = new Proxy(ns, {
			get(target, property) {
				if (property !== "get") {
					const member = Reflect.get(target, property);
					return typeof member === "function" ? member.bind(target) : member;
				}
				return (id: DurableObjectId) =>
					new Proxy(target.get(id), {
						get(stub, p) {
							if (p === "validateSession") {
								return async () => {
									throw new Error(
										"Durable Object reset because its code was updated",
									);
								};
							}
							return Reflect.get(stub, p);
						},
					});
			},
		});
		vi.spyOn(console, "error").mockImplementation(() => {});
		const worker = await import("../../dev/index");
		const answer = await worker.default.fetch(
			new Request("http://local.test/api/v1/auth/me", {
				headers: { Authorization: `Bearer ${sessionToken}` },
			}),
			{ ...env, MAILBOX: unanswering } as never,
			createExecutionContext(),
		);
		expect(answer.status).toBe(503);
		expect(answer.headers.get("Retry-After")).toBeTruthy();
	});

	it("that is simply not valid is still 401", async () => {
		const worker = await import("../../dev/index");
		const answer = await worker.default.fetch(
			new Request("http://local.test/api/v1/auth/me", {
				headers: { Authorization: "Bearer no-such-session" },
			}),
			env as never,
			createExecutionContext(),
		);
		expect(answer.status).toBe(401);
	});
});

/**
 * A sign-in to an address with no account answered at once, and one with an
 * account only after 100,000 rounds of PBKDF2: the difference said which
 * addresses have accounts.
 */
describe("a sign-in to an address with no account", () => {
	it("costs a password check all the same", async () => {
		const auth = env.MAILBOX.get(env.MAILBOX.idFromName("AUTH"));
		const derived = await runInDurableObject(
			auth,
			async (instance: MailboxDO) => {
				const derive = vi.spyOn(crypto.subtle, "deriveBits");
				const session = await instance.login("nobody@example.com", "guess");
				return { session, calls: derive.mock.calls.length };
			},
		);
		expect(derived).toEqual({ session: null, calls: 1 });
	});
});
