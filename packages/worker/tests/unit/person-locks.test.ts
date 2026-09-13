import { describe, expect, it, vi } from "vitest";
import {
	forgetPersonDeletionLock,
	forgetPersonDeletionLockQuietly,
	isPersonDeletionLocked,
	readPersonDeletionLocks,
	setPersonDeletionLock,
} from "../../src/app-settings";

/**
 * Reading the deletion locks, including when the read does not work.
 *
 * The integration tests put real requests through the routes. What is here is
 * the part that only shows when the bucket misbehaves, which no request in a
 * test pool can arrange: a read that throws.
 *
 * It has to come back as "everybody locked", and it has to come back rather
 * than throw. Both halves matter and for different reasons. Locked is the
 * safe direction -- a transient failure must not be the moment an account
 * becomes deletable in one touch. And swallowing it keeps the account list
 * alive: the locks are read on the way to drawing that screen, so letting one
 * bad read escape turned "the lock is unknown" into "the accounts cannot be
 * read at all".
 */

const bucketThat = (get: () => Promise<unknown>) =>
	({ BUCKET: { get } }) as unknown as Parameters<
		typeof readPersonDeletionLocks
	>[0];

describe("an absent flag", () => {
	it("means locked, for a person nobody has ever set", () => {
		expect(isPersonDeletionLocked({}, "somebody")).toBe(true);
		expect(isPersonDeletionLocked(null, "somebody")).toBe(true);
	});

	it("is the only thing that reads as unlocked being false", () => {
		expect(isPersonDeletionLocked({ somebody: false }, "somebody")).toBe(false);
		expect(isPersonDeletionLocked({ somebody: true }, "somebody")).toBe(true);
		// Another person's entry says nothing about this one.
		expect(isPersonDeletionLocked({ other: false }, "somebody")).toBe(true);
	});
});

describe("a read that does not work", () => {
	it("comes back as everybody locked when the bucket throws", async () => {
		const locks = await readPersonDeletionLocks(
			bucketThat(() => Promise.reject(new Error("R2 said no"))),
		);
		expect(locks).toEqual({});
		expect(isPersonDeletionLocked(locks, "somebody")).toBe(true);
	});

	it("comes back as everybody locked when the object will not parse", async () => {
		const locks = await readPersonDeletionLocks(
			bucketThat(() =>
				Promise.resolve({ json: () => Promise.reject(new Error("not JSON")) }),
			),
		);
		expect(locks).toEqual({});
	});

	it("comes back as everybody locked when there is no object yet", async () => {
		const locks = await readPersonDeletionLocks(
			bucketThat(() => Promise.resolve(null)),
		);
		expect(locks).toEqual({});
	});
});

/**
 * The other half, and the one that bites: writing on top of a read that
 * failed. The forgiving read answers `{}`, and a read-modify-write on `{}`
 * puts back a map holding the one person being changed -- every other
 * unlock discarded, and the route answering 200 as though it had worked.
 *
 * Nobody becomes deletable that way (an unlock needs an explicit `false`, and
 * what is lost is exactly those), so it is lost work rather than lost
 * protection. It is still root's decisions thrown away silently, and the
 * split into its own object was made to stop precisely this shape of loss.
 */
describe("a write on top of a read that did not work", () => {
	const bucketThatFailsToRead = () => {
		const put = vi.fn(() => Promise.resolve());
		return {
			env: {
				BUCKET: {
					get: () => Promise.reject(new Error("R2 said no")),
					put,
				},
			} as unknown as Parameters<typeof setPersonDeletionLock>[0],
			put,
		};
	};

	it("does not happen at all", async () => {
		const { env, put } = bucketThatFailsToRead();
		await expect(
			setPersonDeletionLock(env, "somebody", false),
		).rejects.toThrow();
		expect(put).not.toHaveBeenCalled();
	});

	it("does not happen when forgetting a person either", async () => {
		const { env, put } = bucketThatFailsToRead();
		await expect(forgetPersonDeletionLock(env, "somebody")).rejects.toThrow();
		expect(put).not.toHaveBeenCalled();
	});

	/**
	 * The two cases that are not failures: nothing stored yet is the first
	 * write, and an object that will not parse holds nothing worth keeping --
	 * refusing there would leave root unable to move any lock until somebody
	 * edited the bucket by hand.
	 */
	it("still writes when there is nothing stored, or nothing readable", async () => {
		for (const get of [
			() => Promise.resolve(null),
			() => Promise.resolve({ json: () => Promise.reject(new Error("bad")) }),
		]) {
			const put = vi.fn(() => Promise.resolve());
			const env = { BUCKET: { get, put } } as unknown as Parameters<
				typeof setPersonDeletionLock
			>[0];
			await setPersonDeletionLock(env, "somebody", false);
			expect(put).toHaveBeenCalledOnce();
			expect(JSON.parse(put.mock.calls[0][1] as unknown as string)).toEqual({
				somebody: false,
			});
		}
	});

	/**
	 * Except in the one place that runs after the person is already gone.
	 *
	 * Throwing there answers "could not delete" to a deletion that took the
	 * logins, the mailboxes, the mail, the archives and the sending key and
	 * finished. The retry then says 404, and root has two answers with no way
	 * to tell which happened. A leftover entry keyed by an id that will never
	 * be issued again is the cheaper of the two by a long way.
	 */
	it("is forgiven when the person has already been deleted", async () => {
		const { env, put } = bucketThatFailsToRead();
		const complaint = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(
			forgetPersonDeletionLockQuietly(env, "somebody"),
		).resolves.toBeUndefined();
		expect(put).not.toHaveBeenCalled();
		// Forgiven is not the same as unnoticed.
		expect(complaint).toHaveBeenCalledOnce();
		complaint.mockRestore();
	});

	it("keeps everyone else's entry when the read does work", async () => {
		const put = vi.fn(() => Promise.resolve());
		const env = {
			BUCKET: {
				get: () =>
					Promise.resolve({
						json: () => Promise.resolve({ other: false, third: true }),
					}),
				put,
			},
		} as unknown as Parameters<typeof setPersonDeletionLock>[0];

		await setPersonDeletionLock(env, "somebody", false);
		expect(JSON.parse(put.mock.calls[0][1] as unknown as string)).toEqual({
			other: false,
			third: true,
			somebody: false,
		});
	});
});
