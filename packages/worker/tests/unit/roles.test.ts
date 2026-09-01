import { describe, expect, it } from "vitest";
import { roleOf } from "../../src/roles";

/**
 * Who is root.
 *
 * An account id held in this application's own storage, not a deployment
 * variable: this is software people fork and deploy, and asking them to go to
 * GitHub to say who administers their own mail would be a strange thing to
 * require. An id rather than an address, because an address can be changed by
 * its owner and comparing addresses means normalising them -- and somebody
 * eventually wonders whether to strip a "+tag".
 */

const ROOT_ID = "user-1";

describe("roleOf", () => {
	it("gives root to the stored account", () => {
		expect(roleOf({ id: ROOT_ID, isAdmin: true }, ROOT_ID)).toBe("root");
		// Being root does not depend on also being an administrator.
		expect(roleOf({ id: ROOT_ID, isAdmin: false }, ROOT_ID)).toBe("root");
	});

	it("gives admin to an administrator who is not it", () => {
		expect(roleOf({ id: "user-2", isAdmin: true }, ROOT_ID)).toBe("admin");
	});

	it("gives member to everyone else", () => {
		expect(roleOf({ id: "user-2", isAdmin: false }, ROOT_ID)).toBe("member");
	});

	/**
	 * The state every deployment starts in, and every existing one upgrades
	 * into. Nobody is root and every root-only route refuses everyone, which
	 * is the safe direction: the deployment carries on exactly as before.
	 */
	it("makes nobody root before one has been named", () => {
		for (const stored of [null, undefined, ""]) {
			expect(roleOf({ id: ROOT_ID, isAdmin: true }, stored)).toBe("admin");
			expect(roleOf({ id: "", isAdmin: false }, stored)).toBe("member");
		}
	});

	// An account with no id must not match a deployment with no root.
	it("does not match an empty id against an empty setting", () => {
		expect(roleOf({ id: "", isAdmin: true }, "")).toBe("admin");
	});
});
