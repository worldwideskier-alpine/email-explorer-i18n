import { describe, expect, it } from "vitest";

/**
 * The delete button on the account list is behind a lock.
 *
 * Deleting a person takes their logins, their mailboxes, the mail in them and
 * every nightly archive, and nothing brings any of it back. On a phone that
 * button sat one touch from the refresh link, beside somebody else's row.
 * It is now the same two-step a mailbox has had all along: turn the lock off,
 * then delete.
 *
 * The Worker refuses the deletion with 423 while the lock is on -- that is the
 * boundary, and person-deletion-lock.test.ts holds it. What is held here is
 * the screen's half: that the button is not reachable while the lock is on,
 * that unlocking asks first, and that a row arriving without the flag is
 * treated as locked rather than as deletable.
 *
 * Read from the source for the reason formContrast.test.ts documents: the
 * dashboard's tests run in node, without a DOM to mount into.
 */

const source = Object.values(
	import.meta.glob("./Root.vue", {
		query: "?raw",
		import: "default",
		eager: true,
	}) as Record<string, string>,
)[0];

describe("the delete button", () => {
	it("is not on the screen while the lock is on", () => {
		// The hint and the button are the two halves of one v-if/v-else, so
		// there is no state in which both are rendered -- and none in which
		// the button is rendered and the lock is on.
		const hint = source.indexOf('t("root.lock.lockedHint")');
		const button = source.indexOf('t("root.deleteAccount")');
		expect(hint).toBeGreaterThan(-1);
		expect(button).toBeGreaterThan(hint);

		const between = source.slice(hint, button);
		expect(between).toContain("v-else");
		expect(source.slice(0, hint)).toContain('v-if="person.deletionLocked"');
	});

	it("keeps the two confirmations it already had", () => {
		// The lock is a guard against the touch, not a replacement for being
		// asked. Both questions are still put once the lock is off.
		expect(source).toContain('t("root.confirmDelete"');
		expect(source).toContain('t("root.confirmDeleteAgain"');
	});
});

describe("the lock itself", () => {
	it("asks before unlocking, and not before locking", () => {
		const start = source.indexOf("async function toggleLock");
		expect(start).toBeGreaterThan(-1);
		const body = source.slice(start, source.indexOf("\n}", start));

		// One direction arms the irreversible button; the other disarms it.
		// A confirmation on the safe direction only teaches people to dismiss
		// confirmations.
		expect(body).toContain("if (!next)");
		expect(body).toContain('t("root.lock.confirmUnlock"');
		expect(body.match(/window\.confirm/g) ?? []).toHaveLength(1);
	});

	/**
	 * This test used to count `await load()` in the handler and call that
	 * "shows what the server holds". It passed while the screen was wrong:
	 * the switch was a checkbox, the browser owned its position, and no
	 * amount of reloading moved it back -- Vue writes a DOM property only
	 * when the bound value changed, and dismissing the question changes
	 * nothing. Counting calls in the source cannot see that. What can is a
	 * mounted component, which is where the behaviour is held now
	 * (components/toggleSwitch.test.ts); what is left here is the one thing
	 * this file can honestly check, which is that the screen uses it.
	 */
	it("draws the switch from the data, with no state of its own", () => {
		expect(source).toContain("<ToggleSwitch");
		expect(source).toContain(':on="person.deletionLocked"');
		expect(source).not.toMatch(/<input[^>]*:checked=/);
	});

	it("reads a row with no flag on it as locked", () => {
		// A deployment that predates the lock has no flag stored, and the
		// dashboard may briefly be newer than the Worker mid-deploy. Either
		// way the absent one must not read as "deletable".
		expect(source).toContain("person.deletionLocked !== false");
	});
});
