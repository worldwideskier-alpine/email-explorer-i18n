/** How many times a write that lost a race is tried again. */
const ATTEMPTS = 5;

/**
 * Thrown when every attempt found the object changed since it was read.
 * Nothing was written.
 */
export class ConcurrentWriteError extends Error {
	constructor(key: string) {
		super(`${key} kept changing while it was being updated`);
		this.name = "ConcurrentWriteError";
	}
}

/**
 * Read-modify-write of one JSON object in R2 that cannot overwrite a write it
 * did not see.
 *
 * Several writers share a mailbox's settings object: a save from the settings
 * screen, a spam verdict, the nightly backup and purge recording their
 * results. Each read the object, changed its own part and put the whole thing
 * back, so two at once left only the second -- a verdict given while the
 * backup was running was gone the next morning. The put here is conditional
 * on the object still being the one that was read (its etag); when another
 * writer got there first, the change is made again on what they wrote.
 *
 * `change` gets the stored value and returns the value to store, or
 * `undefined` to write nothing. It may run more than once, so it must not do
 * anything but compute. A missing object is handed over as `null`; returning
 * a value then creates it, but only if it is still missing.
 *
 * Answers what was stored, or `undefined` when nothing was.
 */
export async function rewriteJson<T>(
	bucket: R2Bucket,
	key: string,
	change: (stored: T | null) => T | undefined,
	options: {
		/**
		 * An object that will not parse is handed over as `null` rather than
		 * thrown, for a caller whose object holds nothing worth refusing a
		 * write over. The put is still conditional on it.
		 */
		replaceUnreadable?: boolean;
	} = {},
): Promise<T | undefined> {
	for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
		const object = await bucket.get(key);
		let stored: T | null = null;
		if (object) {
			const text = await object.text();
			try {
				stored = JSON.parse(text) as T;
			} catch (error) {
				if (!options.replaceUnreadable) throw error;
			}
		}
		const next = change(stored);
		if (next === undefined) return undefined;
		const written = await bucket.put(key, JSON.stringify(next), {
			onlyIf: object
				? { etagMatches: object.etag }
				: // Created only if nobody else created it in the meantime.
					{ uploadedBefore: new Date(0) },
		});
		if (written) return next;
	}
	throw new ConcurrentWriteError(key);
}
