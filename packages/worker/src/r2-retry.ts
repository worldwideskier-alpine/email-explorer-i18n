/**
 * A call to R2 that is made again when R2 says to make it again, and only
 * then: "Reduce your rate of simultaneous reads on the same object. (10058)"
 * and "We encountered an internal error. Please try again. (10001)".
 *
 * On 2026-10-15 the larger mailbox's backup failed on one read with "get:
 * Reduce your rate of simultaneous reads on the same object. (10058)" -- one
 * of some 1,700 reads that night -- and the whole archive was lost to it,
 * since nothing read again. Why R2 said it is not known: the night's own
 * reads take each original once, but two mailboxes' nights run at once, and
 * whether any message's original is named by rows in both has not been
 * counted. On 2026-10-17 it was a part of the same mailbox's archive, refused
 * with 10001, and the archive was lost the same way: only reads were asked
 * again then, and only on 10058. Every other failure is thrown at once:
 * retrying what will not change only spends the night's time.
 *
 * The waits add up to under six seconds, inside the shortest limit any
 * caller holds a call to (ten seconds, for the run's record), so the caller's
 * limit, not this, is what ends a call that never comes back.
 */

/** R2's codes for "make it again": an internal error, and slow down. */
const TRY_AGAIN = [10001, 10058];

/** Waits before each new attempt; jittered, so two callers do not meet again. */
export const RETRY_DELAYS_MS = [250, 500, 1000, 2000];

export function asksToTryAgain(e: unknown): boolean {
	if (!(e instanceof Error)) return false;
	const code = (e as { code?: unknown }).code;
	return (
		(typeof code === "number" && TRY_AGAIN.includes(code)) ||
		/\((?:10001|10058)\)\s*$/.test(e.message)
	);
}

/**
 * Which kind of object a key names -- `raw`, `attachments`, `backup-carry`,
 * `mailboxes`, `maintenance` -- and nothing of which one: the rest of a key
 * can be a mailbox's address.
 */
export function keyKind(key: string): string {
	return key.split("/", 1)[0] ?? "";
}

/**
 * Makes `work` again for as long as R2 says to and the delays last. `doing`
 * is for the log, and names no key: "reading raw/…", "uploading a part of
 * the archive".
 */
export async function retrying<T>(
	work: () => Promise<T>,
	doing: string,
	delays: readonly number[] = RETRY_DELAYS_MS,
	sleep: (ms: number) => Promise<void> = (ms) =>
		new Promise((done) => setTimeout(done, ms)),
): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await work();
		} catch (e) {
			const wait = delays[attempt];
			if (wait === undefined || !asksToTryAgain(e)) throw e;
			console.warn(
				`R2 said to try ${doing} again (${(e as { code?: unknown }).code ?? "no code"}); trying again (${attempt + 1})`,
			);
			await sleep(wait / 2 + Math.random() * wait);
		}
	}
}

export function readRetrying<T>(
	read: () => Promise<T>,
	/** What is read, for the log: a kind of object, never a key. */
	kind: string,
	delays: readonly number[] = RETRY_DELAYS_MS,
	sleep?: (ms: number) => Promise<void>,
): Promise<T> {
	return retrying(read, `reading ${kind}/…`, delays, sleep);
}

/**
 * The object's bytes, or null when there is none; the body is read again
 * with the get. A read that still fails says which kind of object it was,
 * since R2's own message names none -- on 2026-10-15 it did not say whether
 * an original or an attachment had been refused.
 */
export async function getBytes(
	bucket: R2Bucket,
	key: string,
): Promise<Uint8Array | null> {
	const kind = keyKind(key);
	try {
		return await readRetrying(async () => {
			const object = await bucket.get(key);
			return object ? new Uint8Array(await object.arrayBuffer()) : null;
		}, kind);
	} catch (e) {
		if (!(e instanceof Error)) throw e;
		throw Object.assign(new Error(`${kind}/…: ${e.message}`, { cause: e }), {
			code: (e as { code?: unknown }).code,
		});
	}
}
