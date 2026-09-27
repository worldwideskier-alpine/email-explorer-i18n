import { describe, expect, it } from "vitest";

/**
 * Every address and password field says what it is for, so the browser's
 * password manager fills only the ones that are the viewer's own sign-in.
 *
 * Root's "add an account" form had no hint, and Chrome filled it with
 * root's own saved address and password -- one press of "Add" from making
 * an account out of root's own credentials. A field for somebody else's
 * address, a new address or a new password must say so.
 */

// The screens, and the forms that live in components/, out of reach of
// "./*.vue": the sending-key card /admin and /root share, and the compose
// dialog's recipients. Named rather than globbed: the rest of components/
// holds a `<input type="checkbox" ...>` in a comment these patterns would
// read as a field.
const views = import.meta.glob(
	[
		"./*.vue",
		"../components/ResendKeyCard.vue",
		"../components/ComposeEmail.vue",
	],
	{
		query: "?raw",
		import: "default",
		eager: true,
	},
) as Record<string, string>;

const INPUT = /<input\b[^>]*?>/gs;

interface Field {
	where: string;
	id: string;
	autocomplete: string | undefined;
}

function fields(): Field[] {
	const found: Field[] = [];
	for (const [file, source] of Object.entries(views)) {
		for (const match of source.matchAll(INPUT)) {
			const tag = match[0];
			const type = /\btype="([^"]+)"/.exec(tag)?.[1];
			if (type !== "email" && type !== "password") continue;
			if (/\sdisabled\b/.test(tag)) continue;
			found.push({
				where: `${file}:${source.slice(0, match.index).split("\n").length}`,
				id:
					/\bid="([^"]+)"/.exec(tag)?.[1] ??
					/\bv-model="([^"]+)"/.exec(tag)?.[1] ??
					"?",
				autocomplete: /\bautocomplete="([^"]+)"/.exec(tag)?.[1],
			});
		}
	}
	return found;
}

const hintOf = (file: string, id: string) =>
	fields().find((f) => f.where.startsWith(`./${file}:`) && f.id === id)
		?.autocomplete;

describe("address and password fields", () => {
	it("each say what they are for", () => {
		const all = fields();
		expect(all.length).toBeGreaterThan(15);
		expect(
			all.filter((f) => f.autocomplete === undefined).map((f) => f.where),
		).toEqual([]);
	});

	it("never offer the viewer's own sign-in for somebody else's account", () => {
		expect(hintOf("Root.vue", "newEmail")).toBe("off");
		expect(hintOf("Root.vue", "newPassword")).toBe("new-password");
		expect(hintOf("Root.vue", "recoveryFrom")).toBe("off");
		expect(hintOf("Admin.vue", "new-email")).toBe("off");
		expect(hintOf("Admin.vue", "new-password")).toBe("new-password");
		expect(hintOf("Account.vue", "newEmail")).toBe("off");
		expect(hintOf("Home.vue", "mailbox-email")).toBe("off");
		// Recipients are other people. Unhinted, a type="email" field is
		// filled with the sender's own saved address.
		for (const id of ["to", "cc", "bcc"]) {
			expect(
				fields().find(
					(f) =>
						f.where.startsWith("../components/ComposeEmail.vue:") &&
						f.id === id,
				)?.autocomplete,
				id,
			).toBe("off");
		}
		// An API key, not a password of yours: offering a saved one here
		// would put a sign-in password where a Resend key belongs.
		expect(
			fields().find(
				(f) =>
					f.where.startsWith("../components/ResendKeyCard.vue:") &&
					f.id === "resendApiKey",
			)?.autocomplete,
		).toBe("off");
	});

	/**
	 * `off` is not enough where the form also asks for your password: Chrome
	 * takes the text field before a current-password field for the username
	 * and fills it anyway. Measured on /admin -- the new address arrived
	 * holding the viewer's own. A username field of the form's own, with the
	 * signed-in address, is where Chrome looks instead.
	 */
	it("name whose password is asked for, after the new address", () => {
		const admin = views["./Admin.vue"] as string;
		const username = admin.search(/<input\b[^>]*autocomplete="username"/s);
		expect(username).toBeGreaterThan(admin.indexOf('id="new-email"'));
		expect(username).toBeLessThan(admin.indexOf('id="add-current-password"'));
		const tag = /<input\b[^>]*autocomplete="username"[^>]*>/s.exec(admin)?.[0];
		expect(tag).toContain(':value="authStore.currentUser?.email');
		expect(tag).toMatch(/\shidden\b/);
	});

	it("ask for a new password where one is being chosen", () => {
		for (const [file, id] of [
			["Register.vue", "password"],
			["Register.vue", "confirm-password"],
			["ResetPassword.vue", "password"],
			["ResetPassword.vue", "confirm-password"],
		] as const) {
			expect(hintOf(file, id), `${file} ${id}`).toBe("new-password");
		}
		expect(hintOf("Login.vue", "password")).toBe("current-password");
	});
});
