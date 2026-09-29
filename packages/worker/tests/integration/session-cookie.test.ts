import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sessionTokenFrom } from "../../src/routes/auth";
import { sessionToken, testAuthBeforeAll } from "./utils";

/**
 * The session cookie is found by its whole name. The pattern that found it
 * also matched the end of any other cookie's name, so another application on
 * the same site with a `user_session` cookie ahead of ours made every request
 * here fail, and a sign-out ended that other token instead of ours.
 */
describe("the session cookie", () => {
	it("is read by its own name, not the end of another's", () => {
		expect(
			sessionTokenFrom(null, "user_session=theirs; session=ours; x=1"),
		).toBe("ours");
		expect(sessionTokenFrom(null, "csession=theirs")).toBeNull();
		expect(sessionTokenFrom(null, "session=ours")).toBe("ours");
		expect(sessionTokenFrom(null, " a=1 ;  session = ours ")).toBe("ours");
	});

	it("gives way to a bearer token", () => {
		expect(sessionTokenFrom("Bearer tok", "session=ours")).toBe("tok");
	});

	describe("on a request", () => {
		beforeEach(testAuthBeforeAll);

		it("signs the request in beside another site's session cookie", async () => {
			const res = await SELF.fetch("http://local.test/api/v1/auth/me", {
				headers: { Cookie: `user_session=theirs; session=${sessionToken}` },
			});
			expect(res.status).toBe(200);
		});
	});
});
