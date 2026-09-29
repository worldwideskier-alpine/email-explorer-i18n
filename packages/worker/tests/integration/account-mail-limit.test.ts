import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../../src/password";
import {
	authenticatedFetch,
	enableAccountRecovery,
	testAuthBeforeAll,
	userId,
} from "./utils";

/**
 * Confirmation mail for an address change is limited, and a right password
 * elsewhere does not lift the limit.
 *
 * The count of mail sent and the count of password guesses shared keys, and
 * every route that asks for the password clears the guessing count when it
 * is right. So a session could send a confirmation, prove the password on
 * another screen, and send again -- as many as it liked, from the owner's
 * own sending key, at whatever address it named.
 */

const PASSWORD = "the-fixture-password";

beforeEach(async () => {
	await testAuthBeforeAll();
	await enableAccountRecovery();
	const hash = await hashPassword(PASSWORD);
	await runInDurableObject(
		env.MAILBOX.get(env.MAILBOX.idFromName("AUTH")),
		async (_i, state) => {
			state.storage.sql.exec(
				"UPDATE users SET password_hash = ? WHERE id = ?",
				hash,
				userId,
			);
		},
	);
});

const askToMove = (n: number) =>
	authenticatedFetch("http://local.test/api/v1/auth/change-email", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			currentPassword: PASSWORD,
			newEmail: `elsewhere-${n}@example.net`,
		}),
	});

/** A right password on another screen: setting the sending key. */
const proveElsewhere = () =>
	authenticatedFetch("http://local.test/api/v1/admin/settings/resend", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			apiKey: "re_placeholder_for_tests",
			currentPassword: PASSWORD,
		}),
	});

describe("confirmation mail for an address change", () => {
	it("stops at the limit, whatever is proved in between", async () => {
		for (let n = 0; n < 10; n++) {
			expect((await askToMove(n)).status).toBe(200);
			expect((await proveElsewhere()).status).toBe(200);
		}
		expect((await askToMove(10)).status).toBe(429);
	});
});
