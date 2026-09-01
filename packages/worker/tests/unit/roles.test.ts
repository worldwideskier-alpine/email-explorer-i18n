import { describe, expect, it } from "vitest";
import { isRoot, normalizeLoginEmail, roleOf } from "../../src/roles";

/**
 * Who is root.
 *
 * Decided by a deployment setting rather than a column, so that nobody can
 * take the role from inside the application and nobody can lose it for good.
 * Everything below is a way that could go wrong quietly -- a role granted to
 * the wrong address grants the ability to delete every account.
 */

const ROOT = "worldwideskier+admin@gmail.com";

const admin = (email: string) => ({ email, isAdmin: true });
const member = (email: string) => ({ email, isAdmin: false });

describe("roleOf", () => {
	it("gives root to the configured address", () => {
		expect(roleOf(admin(ROOT), ROOT)).toBe("root");
		// Being root does not depend on also being an administrator.
		expect(roleOf(member(ROOT), ROOT)).toBe("root");
	});

	it("gives admin to an administrator who is not it", () => {
		expect(roleOf(admin("someone@example.com"), ROOT)).toBe("admin");
	});

	it("gives member to everyone else", () => {
		expect(roleOf(member("someone@example.com"), ROOT)).toBe("member");
	});

	/**
	 * The failure that matters most. `worldwideskier+admin@gmail.com` and
	 * `worldwideskier@gmail.com` reach the same Gmail inbox, which is what
	 * makes one address usable as two logins -- and it would be undone by any
	 * comparison clever enough to "helpfully" strip the tag. The ordinary
	 * account would silently become root.
	 */
	it("does not treat the address without the tag as root", () => {
		expect(roleOf(admin("worldwideskier@gmail.com"), ROOT)).toBe("admin");
		expect(roleOf(admin("worldwideskier+other@gmail.com"), ROOT)).toBe("admin");
	});

	// Registration does not fold case, so both spellings can exist as
	// accounts and both have to resolve the same way.
	it("ignores case and surrounding space", () => {
		expect(roleOf(admin("WorldWideSkier+Admin@Gmail.com"), ROOT)).toBe("root");
		expect(roleOf(admin(` ${ROOT} `), ROOT)).toBe("root");
		expect(roleOf(admin(ROOT), ` ${ROOT.toUpperCase()} `)).toBe("root");
	});

	/**
	 * The state every existing deployment upgrades into. No configured
	 * address means nobody is root and every root-only route refuses
	 * everyone -- which is the safe direction: the deployment carries on
	 * exactly as it did before.
	 */
	it("makes nobody root when no address is configured", () => {
		for (const configured of [undefined, "", "   "]) {
			expect(roleOf(admin(ROOT), configured)).toBe("admin");
			expect(isRoot(admin(ROOT), configured)).toBe(false);
		}
	});

	it("does not make an empty address match an empty account", () => {
		expect(roleOf(admin(""), "")).toBe("admin");
		expect(roleOf(admin(""), undefined)).toBe("admin");
	});
});

describe("normalizeLoginEmail", () => {
	it("folds case and trims, and keeps everything else", () => {
		expect(normalizeLoginEmail("  A+Tag@Example.COM ")).toBe("a+tag@example.com");
	});
});
