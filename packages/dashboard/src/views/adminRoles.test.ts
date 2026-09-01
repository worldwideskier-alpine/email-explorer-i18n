import { describe, expect, it } from "vitest";

/**
 * The role column says which of three roles an account holds.
 *
 * It used to print one of two words from the `isAdmin` flag. Root is
 * deliberately not an administrator -- its job is the account list, not the
 * mail -- so the account at the top of the hierarchy appeared under the
 * bottom label, in a row of the accounts it had itself created, with a button
 * offering to change its privileges. A flag with two states cannot name three
 * roles; the Worker sends the role, and the screen prints what it is sent.
 *
 * Sources come from import.meta.glob rather than node:fs, for the reason
 * formContrast.test.ts documents: src/ is type-checked without Node types.
 */

const admin = Object.values(
	import.meta.glob("./Admin.vue", {
		query: "?raw",
		import: "default",
		eager: true,
	}) as Record<string, string>,
)[0];

const ja = Object.values(
	import.meta.glob("../locales/ja.json", {
		import: "default",
		eager: true,
	}) as Record<string, { admin: { users: Record<string, string> } }>,
)[0];

/** The role cell: the one `<td>` that renders a role label. */
const roleCell = /<td[^>]*>\s*<span v-if="roleOf\(user\)[\s\S]*?<\/td>/.exec(
	admin,
)?.[0];

describe("the role column", () => {
	it("names all three roles", () => {
		expect(roleCell).toBeDefined();
		expect(roleCell).toContain("admin.users.roleRoot");
		expect(roleCell).toContain("admin.users.roleAdmin");
		expect(roleCell).toContain("admin.users.roleUser");
	});

	// The defect: with only the flag to go on, root fell to the else branch.
	it("does not decide the label from the isAdmin flag", () => {
		expect(roleCell).not.toContain("user.isAdmin");
	});

	it("asks the same question the Worker answers", () => {
		expect(admin).toContain(`role?: "root" | "admin" | "member"`);
	});
});

describe("what the admin screen offers to do to root", () => {
	/**
	 * Root creates and deletes the accounts on this screen. Offering to
	 * change its privileges from here draws the hierarchy upside down, and
	 * the Worker refuses the request anyway.
	 */
	it("keeps the privilege and access buttons off root's row", () => {
		const actions = /<!-- The account above this screen[\s\S]*?<\/td>/.exec(
			admin,
		)?.[0];
		expect(actions).toBeDefined();
		expect(actions).toContain(`v-if="roleOf(user) === 'root'"`);
		expect(actions).toContain("admin.users.rootNotManagedHere");
		// The buttons live in the other half of the branch.
		expect(actions).toMatch(/v-else[\s\S]*admin\.users\.grantAdmin/);
	});
});

/**
 * A one-word label says which box an account is in, not what it can do, and
 * "administrator" and "user" are near enough in ordinary speech to tell
 * nobody anything -- which is what made the column unreadable even where it
 * was not wrong.
 */
describe("each role says what it can do", () => {
	it("gives every role a description on the screen", () => {
		for (const key of ["roleRootDesc", "roleAdminDesc", "roleUserDesc"]) {
			expect(admin).toContain(`admin.users.${key}`);
		}
	});

	it("has wording for each of them", () => {
		for (const key of [
			"roleRoot",
			"roleRootDesc",
			"roleAdminDesc",
			"roleUserDesc",
			"rootNotManagedHere",
		]) {
			expect(ja.admin.users[key]).toBeTruthy();
		}
	});
});
