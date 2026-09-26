import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ConcurrentWriteError, rewriteJson } from "../../src/r2-json";

// @ts-expect-error test binding
const bucket = (): R2Bucket => env.BUCKET;

/** A bucket whose next `put`s are each preceded by somebody else's write. */
function racedBy(times: number, other: (n: number) => Promise<unknown>) {
	let raced = 0;
	return new Proxy(bucket(), {
		get(target, property) {
			if (property === "put") {
				return async (...args: Parameters<R2Bucket["put"]>) => {
					if (raced < times) await other(raced++);
					return target.put(...args);
				};
			}
			const member = Reflect.get(target, property);
			return typeof member === "function" ? member.bind(target) : member;
		},
	});
}

describe("rewriting a JSON object in R2", () => {
	/**
	 * Two writers of one settings object each put back the whole thing, and
	 * the second erased the first. Here the second sees the first's write and
	 * makes its change on top of it.
	 */
	it("keeps a write that landed between its read and its put", async () => {
		await bucket().put("s.json", JSON.stringify({ a: 1 }));
		const raced = racedBy(1, () =>
			bucket().put("s.json", JSON.stringify({ a: 1, verdict: "kept" })),
		);

		const stored = await rewriteJson<Record<string, unknown>>(
			raced,
			"s.json",
			(s) => ({ ...s, backup: "done" }),
		);

		expect(stored).toEqual({ a: 1, verdict: "kept", backup: "done" });
		expect(await (await bucket().get("s.json"))?.json()).toEqual(stored);
	});

	it("writes nothing when told to", async () => {
		await bucket().put("s.json", JSON.stringify({ a: 1 }));
		expect(await rewriteJson(bucket(), "s.json", () => undefined)).toBe(
			undefined,
		);
		expect(await (await bucket().get("s.json"))?.json()).toEqual({ a: 1 });
	});

	it("creates an object that is missing", async () => {
		expect(await rewriteJson(bucket(), "new.json", () => ({ b: 2 }))).toEqual({
			b: 2,
		});
		expect(await (await bucket().get("new.json"))?.json()).toEqual({ b: 2 });
	});

	/** Somebody else created it first: theirs stands, and ours goes on top. */
	it("does not replace an object created while it was deciding", async () => {
		const raced = racedBy(1, () =>
			bucket().put("new.json", JSON.stringify({ theirs: true })),
		);
		const stored = await rewriteJson<Record<string, unknown>>(
			raced,
			"new.json",
			(s) => ({ ...(s ?? {}), ours: true }),
		);
		expect(stored).toEqual({ theirs: true, ours: true });
	});

	it("gives up rather than overwrite, when it never gets a quiet moment", async () => {
		await bucket().put("s.json", JSON.stringify({ n: 0 }));
		const raced = racedBy(100, (n) =>
			bucket().put("s.json", JSON.stringify({ n: n + 1 })),
		);
		await expect(
			rewriteJson(raced, "s.json", (s) => ({ ...(s as object), mine: 1 })),
		).rejects.toBeInstanceOf(ConcurrentWriteError);
		expect(await (await bucket().get("s.json"))?.json()).not.toHaveProperty(
			"mine",
		);
	});
});
