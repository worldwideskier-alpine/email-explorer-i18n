import { describe, expect, it } from "vitest";
import {
	isPersonDeletionLocked,
	readPersonDeletionLocks,
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
