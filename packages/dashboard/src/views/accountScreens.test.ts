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

/**
 * What one administrator can reach that another cannot: nothing.
 *
 * There is one way to make an administrator -- root makes one -- so two of
 * them are the same kind of thing, and any control shown to one and hidden
 * from the other is a defect rather than a policy. Nothing on any screen
 * grants or withholds anything between them.
 *
 * The thing that broke it was `isAdmin`, which reads the Worker's legacy
 * `is_admin` column. Registration sets that column for the first account ever
 * created and nothing sets it on a second, so a control behind it belonged to
 * one particular person. Restoring a backup was behind it, and so was this
 * person's own badge -- the screen whose entire subject is who you are told
 * every administrator but one that they were nobody.
 *
 * What legitimately varies between administrators is which mailboxes they
 * hold. That is a different question, asked per mailbox, and it is what the
 * Worker now asks: see administrators-are-equal.test.ts there.
 */
describe("no screen decides anything by the legacy admin flag", () => {
	/**
	 * Every source in the dashboard, not just the views.
	 *
	 * The first version of this scanned `./*.vue` -- the views beside this
	 * file -- and matched two spellings of the read. Both limits were real:
	 * the same gate written in a component, or written as
	 * `const auth = useAuthStore()` and then `auth.isAdmin`, went unnoticed.
	 * Measured, not assumed: a probe put in Header.vue passed this suite.
	 *
	 * What that probe also showed is where the actual guarantee lives. A read
	 * of a property the store no longer returns does not compile -- vue-tsc
	 * fails the build, so it can never reach a browser. What did compile was
	 * `authStore.session?.isAdmin`, because the field was still on the stored
	 * Session; that one passed the type check and this suite together, and it
	 * is why the field is off the interface now. This looks for the name at
	 * all, so the next spelling of it is caught here rather than by whoever
	 * notices a control has gone missing.
	 */
	const sources = import.meta.glob("../**/*.{vue,ts}", {
		query: "?raw",
		import: "default",
		eager: true,
	}) as Record<string, string>;

	/**
	 * What is left after the parts that can name it without reading it.
	 *
	 * Comments go first: the store explains at length why the flag is gone and
	 * quotes the exact spelling that used to slip through, so a scan of raw
	 * text finds the warning and reports it as the thing it warns about. The
	 * `(^|\s)` before `//` is what keeps `https://` out of that.
	 *
	 * Then message keys, and only those. `t("account.isAdmin")` is the label on
	 * the badge -- the word "administrator", looked up by name -- and it is the
	 * one place the string appears without anything reading the flag.
	 *
	 * An earlier version of this blanked every quoted region instead, which in
	 * a .vue file is every template binding: `v-if="authStore.session?.isAdmin"`
	 * became `v-if=""` and the scan saw nothing. That is the exact shape of the
	 * gate this file exists to keep out -- the one that was on the restore
	 * control -- so the broader rule made the guard blind to the only case that
	 * has ever actually happened here. Measured, not reasoned about: a probe of
	 * that shape passed the suite.
	 */
	const code = (source: string) =>
		source
			.replace(/\/\*[\s\S]*?\*\//g, " ")
			.replace(/<!--[\s\S]*?-->/g, " ")
			.replace(/(^|\s)\/\/.*$/gm, "$1")
			.replace(/\$?t\(\s*(['"])[^'"]*\1/g, "t(");

	it("is not read anywhere in the dashboard", () => {
		for (const [path, source] of Object.entries(sources)) {
			// A read has a dot -- or an optional-chaining `?.` -- in front of it.
			const reads = /[.?]\s*isAdmin\b/.test(code(source));
			expect([path, reads]).toEqual([path, false]);
		}
	});

	/**
	 * And it is not on the Session type either, which is what stopped the
	 * compiler from catching `session?.isAdmin`.
	 *
	 * This reads the source, so it says what the file declares and not what a
	 * sign-in leaves behind -- those came apart once already, the type saying
	 * the field was gone while `session.value = response.data` kept it. What a
	 * sign-in actually stores is asked of a sign-in, in
	 * stores/authSession.test.ts.
	 */
	it("is not declared on the Session type", () => {
		const store = sources["../stores/auth.ts"];
		expect(store).toBeTruthy();
		expect(store).not.toMatch(/^\s*isAdmin: boolean;/m);
		expect(store).not.toMatch(/const isAdmin = computed/);
	});

	/**
	 * Restoring a backup is the control it hid. Reaching a mailbox's settings
	 * screen already means the mailbox is yours, which is the only question
	 * worth asking about writing mail into it.
	 */
	it("shows the restore control to everyone who can open the settings screen", () => {
		const settings = views["./Settings.vue"];
		expect(settings).toContain("settings.restoreTitle");
		const block = /<!--[\s\S]*?Restore:[\s\S]*?-->\s*<div([^>]*)>/.exec(
			settings,
		);
		expect(block).toBeTruthy();
		expect(block?.[1]).not.toContain("v-if");
	});

	// The badge says the role, which every administrator has, rather than the
	// flag, which one of them has.
	it("puts the badge on the role", () => {
		expect(views["./Account.vue"]).toContain("authStore.role === 'admin'");
	});
});
