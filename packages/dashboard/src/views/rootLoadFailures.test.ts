import { describe, expect, it } from "vitest";

/**
 * What the root screen says when it could not ask.
 *
 * This is the screen that exists to say the nightly run failed, and it had
 * three ways of going quiet about a failure of its own.
 *
 * `load()` made two requests in two `try`/`finally` blocks with no `catch`
 * between them. A rejected account list threw out of the function before the
 * second block ran, so `maintenanceLoading` stayed true forever -- and the
 * whole maintenance block is behind `v-if="!maintenanceLoading"`. The one line
 * that reports the nightly run was simply absent, with nothing anywhere to say
 * a request had failed. `onMounted(load)` swallowed the rejection.
 *
 * And each request, when it failed, fell through to the sentence for the
 * emptiness it cannot tell itself from: an unread record rendered as "the
 * scheduled maintenance has never run", and an unread account list as "no
 * users found" -- which on this screen is never true, since you are signed in
 * as one of them. Two confident sentences about a deployment nobody had
 * managed to ask.
 *
 * Sources come from import.meta.glob rather than node:fs, for the reason
 * formContrast.test.ts documents: src/ is type-checked without Node types.
 */

const views = import.meta.glob("./*.vue", {
	query: "?raw",
	import: "default",
	eager: true,
}) as Record<string, string>;

const root = views["./Root.vue"];

const catalogues = import.meta.glob("../locales/*.json", {
	import: "default",
	eager: true,
}) as Record<string, { root: Record<string, any> }>;

const ja = catalogues["../locales/ja.json"];
const en = catalogues["../locales/en.json"];

/** The body of `load()`, up to the closing brace at column zero of the tab. */
const loadBody = root.slice(
	root.indexOf("async function load()"),
	root.indexOf("\n}\n", root.indexOf("async function load()")),
);

describe("one failed request does not take the other down", () => {
	it("catches the account list rather than throwing out of load()", () => {
		expect(loadBody).toContain("api.listAccounts()");
		expect(loadBody).toContain("api.getMaintenance()");

		// The maintenance request has to be reachable with the first one
		// rejected, which means a catch stands between them.
		const accounts = loadBody.indexOf("api.listAccounts()");
		const maintenance = loadBody.indexOf("api.getMaintenance()");
		const between = loadBody.slice(accounts, maintenance);
		expect(between).toContain("catch");
	});

	// Both, not just the one the review named: the same fall-through was on
	// each, and a rejected maintenance request must not take the screen down
	// either now that something is left to run after it.
	it("catches both requests", () => {
		expect(loadBody.match(/catch/g)?.length).toBe(2);
	});

	// The flags start each attempt clean, or a refresh after a failure would
	// keep reporting the failure it has just recovered from.
	it("clears the flags at the start of each attempt", () => {
		expect(loadBody).toContain("accountsUnreadable.value = false");
		expect(loadBody).toContain("maintenanceUnreadable.value = false");
	});
});

describe("a request that failed says so", () => {
	/**
	 * Order is the whole of it. Both sentences are still there and still
	 * correct about the emptiness they describe; what changed is that the
	 * failure is asked about first, so it can no longer be told as one.
	 */
	it("does not report an unread record as a run that never happened", () => {
		const unreadable = root.indexOf('v-if="maintenanceUnreadable"');
		const never = root.indexOf("root.maintenance.never");
		expect(unreadable).toBeGreaterThan(-1);
		expect(never).toBeGreaterThan(-1);
		expect(unreadable).toBeLessThan(never);
	});

	it("does not report an unread account list as no users", () => {
		const unreadable = root.indexOf('v-else-if="accountsUnreadable"');
		const empty = root.indexOf("admin.users.empty");
		expect(unreadable).toBeGreaterThan(-1);
		expect(empty).toBeGreaterThan(-1);
		expect(unreadable).toBeLessThan(empty);
	});

	// Amber, like every other line on this screen that reports trouble. The
	// grey ones are the ones that say nothing is wrong.
	it("says it in the colour the other failures use", () => {
		for (const key of [
			"root.maintenance.unreadable",
			"root.accountsUnreadable",
		]) {
			// The opening tag, which is not always the line the key is on.
			const at = root.indexOf(key);
			expect(at).toBeGreaterThan(-1);
			const tag = root.slice(root.lastIndexOf("<p", at), at);
			expect(tag).toContain("amber");
		}
	});

	// The parity test in locales/ holds all 73; these two are the ones this
	// change is about, and a missing key falls back to English in silence.
	it("has a sentence for each in the catalogues", () => {
		for (const c of [ja, en]) {
			expect(typeof c.root.maintenance.unreadable).toBe("string");
			expect(typeof c.root.accountsUnreadable).toBe("string");
			expect(c.root.maintenance.unreadable).not.toBe("");
			expect(c.root.accountsUnreadable).not.toBe("");
		}
		// And not the same sentence as the emptiness it is told apart from.
		expect(ja.root.maintenance.unreadable).not.toBe(ja.root.maintenance.never);
	});
});
