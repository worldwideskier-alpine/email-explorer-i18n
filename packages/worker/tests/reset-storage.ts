import { reset } from "cloudflare:test";
import { afterEach } from "vitest";

/**
 * Clears the Durable Object and R2 state between tests.
 *
 * @cloudflare/vitest-pool-workers used to do this through an `isolatedStorage`
 * option, which 0.22 removed in favour of an explicit `reset()`. Without it the
 * tests are no longer independent: a mailbox created in one test is still there
 * for the next, a rate-limit counter carries over and turns an expected 401
 * into a 429, and a token written to R2 is found alongside the one the test
 * just wrote.
 *
 * Registered once through `test.setupFiles` so it applies to every test file
 * rather than being repeated in each of them.
 */
afterEach(async () => {
	await reset();
});
