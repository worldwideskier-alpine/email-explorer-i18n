import { describe, expect, it } from "vitest";
import { roleOf } from "../../src/roles";

/**
 * Who is root.
 *
 * A person held in this application's own storage, not a deployment variable:
 * this is software people fork and deploy, and asking them to go to GitHub to
 * say who administers their own mail would be a strange thing to require.
 *
 * A person rather than a login, and an id rather than an address. A person,
 * because the role has to survive losing the address you sign in with -- the
 * alternative is a way to hand the role to somebody else, and on software
 * with customers that is a button that gives a customer the deployment. An
 * id, because an address can be changed by its owner and comparing addresses
 * means normalising them, and somebody eventually wonders whether to strip a
 * "+tag".
 */

const ROOT = "person-1";

describe("roleOf", () => {
	it("gives root to the person holding it", () => {
		expect(roleOf(ROOT, ROOT)).toBe("root");
	});

	/**
	 * The point of holding it against the person: every login of theirs is
	 * root, so a spare address is the whole of succession and recovery. The
	 * function never sees a login, which is how that is guaranteed.
	 */
	it("gives admin to everybody else", () => {
		expect(roleOf("person-2", ROOT)).toBe("admin");
	});

	/**
	 * The state every deployment starts in, and every existing one upgrades
	 * into. Nobody is root and every root-only route refuses everyone, which
	 * is the safe direction: the deployment carries on exactly as before.
	 */
	it("makes nobody root before one has been named", () => {
		for (const stored of [null, undefined, ""]) {
			expect(roleOf(ROOT, stored)).toBe("admin");
			expect(roleOf("person-2", stored)).toBe("admin");
		}
	});

	// A login with no person must not match a deployment with no root.
	it("does not match an empty person against an empty setting", () => {
		expect(roleOf("", "")).toBe("admin");
		expect(roleOf(null, null)).toBe("admin");
		expect(roleOf(undefined, ROOT)).toBe("admin");
	});
});
