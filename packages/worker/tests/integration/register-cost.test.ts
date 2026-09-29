import { env, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MailboxDO } from "../../src/durableObject";

/**
 * Registration is reached without a session, and each attempt used to hash
 * the password -- PBKDF2 at 100,000 iterations, in the one auth object every
 * sign-in on the deployment waits for -- before asking whether registration
 * was open at all. Once root exists it is closed, so every one of those was
 * spent on a refusal, and nothing limited how many a stranger sent.
 */

const register = (email: string, ip = "198.51.100.7") =>
	SELF.fetch("http://local.test/api/v1/auth/register", {
		method: "POST",
		headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
		body: JSON.stringify({ email, password: "password123" }),
	});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("a registration once it is closed", () => {
	it("is refused without hashing anything", async () => {
		expect((await register("root@example.com")).status).toBe(201);

		const auth = env.MAILBOX.get(env.MAILBOX.idFromName("AUTH"));
		const hashed = await runInDurableObject(
			auth,
			async (instance: MailboxDO) => {
				const derive = vi.spyOn(crypto.subtle, "deriveBits");
				const answer = await instance.registerFromForm(
					"late@example.com",
					"password123",
					true,
				);
				return { answer, calls: derive.mock.calls.length };
			},
		);
		expect(hashed).toEqual({ answer: "closed", calls: 0 });
	});
});

describe("registrations from one address", () => {
	it("are limited, and the limit says when to come back", async () => {
		expect((await register("root@example.com")).status).toBe(201);
		const answers: number[] = [];
		for (let i = 0; i < 12; i++) {
			answers.push((await register(`x${i}@example.com`)).status);
		}
		expect(answers.slice(0, 9).every((s) => s === 403)).toBe(true);
		expect(answers.at(-1)).toBe(429);
		// Somebody else is not held up by it.
		expect((await register("y@example.com", "203.0.113.9")).status).toBe(403);
	});
});
