import { describe, expect, it } from "vitest";

/**
 * What the two account screens are, after the role column went.
 *
 * The admin screen used to list every account in the deployment and print a
 * role beside each. Both were wrong in the same way. On a deployment with one
 * person the list reads as "my logins" and looks harmless; with two, it hands
 * each of them the other's address, and it showed root's -- the account that
 * can delete them -- to the people root can delete. The column then had to
 * name three tiers using a two-state flag, and put root, deliberately not an
 * administrator, at the bottom of them.
 *
 * It is now the signed-in person's own logins. Every row is you, so there is
 * nothing for a role column to distinguish, and the column is gone rather
 * than reworded. The root screen keeps a role, because there it separates you
 * from the people you administer.
 *
 * Sources come from import.meta.glob rather than node:fs, for the reason
 * formContrast.test.ts documents: src/ is type-checked without Node types.
 */

const views = import.meta.glob("./*.vue", {
	query: "?raw",
	import: "default",
	eager: true,
}) as Record<string, string>;

const ja = Object.values(
	import.meta.glob("../locales/ja.json", {
		import: "default",
		eager: true,
	}) as Record<string, Record<string, any>>,
)[0];

const admin = views["./Admin.vue"];
const root = views["./Root.vue"];

describe("the admin screen", () => {
	it("lists your own logins and nothing about anybody else", () => {
		expect(admin).toContain("listOwnLogins");
		expect(admin).toContain("addOwnLogin");
		expect(admin).toContain("deleteOwnLogin");
	});

	// The column, its legend, and the three words it needed.
	it("has no role column left", () => {
		for (const gone of [
			"admin.users.roleRoot",
			"admin.users.roleAdmin",
			"admin.users.roleUser",
			"admin.users.columnRole",
		]) {
			expect(admin).not.toContain(gone);
		}
	});

	/**
	 * Handing one person's mailbox to another, at four levels none of which
	 * anything ever read. An address belongs to whoever registered it.
	 */
	it("has no access-management modal", () => {
		expect(admin).not.toContain("accessModal");
		expect(admin).not.toContain("adminGrantAccess");
		expect(admin).not.toContain("adminRevokeAccess");
	});

	// Promoting existed because this screen could make an account that owned
	// nothing. It makes a login belonging to you now, so there is nothing to
	// promote.
	it("has no promote or demote", () => {
		expect(admin).not.toContain("adminSetUserAdmin");
		expect(admin).not.toContain("grantAdmin");
	});
});

describe("the root screen", () => {
	// One row per person: a person is the addresses they sign in with and
	// nothing else, so all of them are listed together. Two rows read as two
	// strangers, each with its own delete button.
	it("lists people, with their addresses together", () => {
		expect(root).toContain("person.emails");
		expect(root).toContain("person.personId");
	});

	/**
	 * The button that could hand a customer the whole deployment. Its guard
	 * was never the problem; its existence was.
	 */
	it("cannot hand the role to anybody", () => {
		expect(root).not.toContain("transferRoot");
		expect(root).not.toContain("root.transfer");
	});

	// Two acts behind one form, told apart by the role.
	it("chooses between making somebody new and adding your own login", () => {
		expect(root).toContain("newRole");
		expect(root).toContain("root.create.roleAdminHint");
		expect(root).toContain("root.create.roleRootHint");
	});

	// Deleting takes the mail with it, so it is asked about twice.
	it("asks twice before deleting a person", () => {
		expect(root).toContain("root.confirmDelete");
		expect(root).toContain("root.confirmDeleteAgain");
	});
});

describe("the wording", () => {
	it("says what each new string is for", () => {
		expect(ja.admin.registerUser.description).toBeTruthy();
		expect(ja.admin.users.description).toBeTruthy();
		expect(ja.admin.users.onlyOne).toBeTruthy();
		expect(ja.root.roleAdmin).toBeTruthy();
		expect(ja.root.confirmDeleteAgain).toBeTruthy();
		expect(ja.root.create.roleRootHint).toBeTruthy();
	});

	// Wording for a screen that is gone is wording nobody will ever read, and
	// it has to be translated in every catalogue to stay parallel.
	it("keeps nothing for the screens that went", () => {
		expect(ja.admin.accessModal).toBeUndefined();
		expect(ja.admin.users.roleUser).toBeUndefined();
		expect(ja.root.transfer).toBeUndefined();
	});
});
