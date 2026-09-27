/**
 * Waiting with a limit, for the nightly run.
 *
 * The run is killed at fifteen minutes of wall time, and it does not get to
 * say anything when it is. On 2026-09-22 it was: `exceededWallTime` at
 * 899968 ms having used 716 ms of CPU -- fourteen minutes of waiting on one
 * call that never answered. No archive was written for either mailbox that
 * night, the upload each had begun was never aborted, the spam purge never
 * started, and the only record of the night was overwritten by the next one.
 *
 * Nothing here can make a call answer. What it can do is stop waiting for it:
 * the caller gets an error it can record and move past, and the rest of the
 * night still happens. The abandoned call is not cancelled -- there is no way
 * to -- and is simply dropped when the invocation ends.
 */

/** What a call that did not answer in time rejects with. */
export class OutOfTime extends Error {
	constructor(what: string, ms: number) {
		super(
			`${what} did not answer within ${Math.max(0, Math.round(ms / 1000))}s`,
		);
		this.name = "OutOfTime";
	}
}

/**
 * `work`, or an OutOfTime after `ms`, whichever comes first.
 *
 * With no time left at all it rejects straight away rather than starting a
 * timer of zero, so a pass that has run out of its budget stops at the next
 * call instead of one call later.
 */
export function within<T>(
	work: Promise<T>,
	ms: number,
	what: string,
): Promise<T> {
	if (!Number.isFinite(ms)) return work;
	if (ms <= 0) {
		// Nobody will wait for it now; its failure must not surface as an
		// unhandled rejection later.
		work.catch(() => {});
		return Promise.reject(new OutOfTime(what, 0));
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new OutOfTime(what, ms)), ms);
	});
	return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/**
 * How long one call of the backup or the purge may take.
 *
 * Every one of them -- a page of messages from a mailbox, a batch of renders,
 * a 5 MiB part -- takes seconds on a normal night. A minute is long enough
 * that no honest call reaches it and short enough that a hung one costs one
 * mailbox a minute rather than the whole night fifteen.
 */
export const CALL_LIMIT_MS = 60_000;

/**
 * The limits a pass works within: a moment it must be done by, and the
 * longest any one call may take before then.
 */
export interface TimeLimits {
	/** Epoch milliseconds. Absent means no end but the per-call limit. */
	deadline?: number;
	/** Absent means CALL_LIMIT_MS. Tests pass a small one. */
	callLimitMs?: number;
}

/** A `within` bound to one pass's limits: the per-call limit or what is left, whichever is less. */
export function limitedBy(limits: TimeLimits = {}) {
	const deadline = limits.deadline ?? Number.POSITIVE_INFINITY;
	const callLimit = limits.callLimitMs ?? CALL_LIMIT_MS;
	return <T>(work: Promise<T>, what: string): Promise<T> =>
		within(work, Math.min(callLimit, deadline - Date.now()), what);
}

/** Whether a pass's deadline has already gone by. */
export function pastDeadline(limits: TimeLimits = {}): boolean {
	return limits.deadline !== undefined && Date.now() >= limits.deadline;
}
