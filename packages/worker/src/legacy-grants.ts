/**
 * Gives every mailbox that already existed an explicit owner.
 *
 * Until now an administrator saw every mailbox by bypassing the access check
 * altogether, so the mailboxes an administrator actually used had **no
 * grant rows at all**. Nothing pointed from a person to an address; the
 * connection was "is an administrator", and that was enough.
 *
 * The moment that bypass is removed, every one of those mailboxes disappears
 * from every screen -- the mail is still there and still arriving, but nobody
 * can open it. On a deployment carrying a business's live mail that is not an
 * acceptable few minutes.
 *
 * So the grants are written first, while the bypass is still in place and
 * nothing depends on them. This runs on its own, once, from whichever request
 * arrives first after the deploy. By the time the bypass is removed the rows
 * it needs are already there, and removing it changes nothing for anyone.
 *
 * It is deliberately a one-time backfill and not a rule. Repeating it would
 * mean every administrator owning every mailbox for ever, which is the thing
 * being moved away from: mailboxes made after this get their owner from
 * whoever creates them.
 */

import { LEGACY_ADMIN_PERSON_ID } from "./people";
import type { Env } from "./types";

/**
 * Written when the backfill has run. In the bucket rather than in the Durable
 * Object because the mailbox list is in the bucket: a marker beside the thing
 * it describes cannot get out of step with it.
 */
const MARKER_KEY = "system/mailbox-grants-backfilled.json";

const MAILBOX_PREFIX = "mailboxes/";

/**
 * Cheap per-isolate memory of "already done", so the steady state costs
 * nothing. Not correctness -- the marker in the bucket is what actually
 * decides -- just a way to avoid a HEAD on every request once it has run.
 */
let checkedInThisIsolate = false;

export interface BackfillResult {
	/** False when it had already run, so nothing was looked at. */
	ran: boolean;
	mailboxes: number;
	accounts: number;
	granted: number;
}

async function listMailboxIds(env: Env): Promise<string[]> {
	const ids: string[] = [];
	let cursor: string | undefined;
	do {
		const listed = await env.BUCKET.list({ prefix: MAILBOX_PREFIX, cursor });
		for (const object of listed.objects) {
			const id = object.key.slice(MAILBOX_PREFIX.length).replace(/\.json$/, "");
			if (id) ids.push(id);
		}
		cursor = listed.truncated ? listed.cursor : undefined;
	} while (cursor);
	return ids;
}

export async function ensureLegacyMailboxGrants(
	env: Env,
): Promise<BackfillResult> {
	const nothingToDo: BackfillResult = {
		ran: false,
		mailboxes: 0,
		accounts: 0,
		granted: 0,
	};

	if (checkedInThisIsolate) return nothingToDo;
	if (await env.BUCKET.head(MARKER_KEY)) {
		checkedInThisIsolate = true;
		return nothingToDo;
	}

	const authDO = env.MAILBOX.get(env.MAILBOX.idFromName("AUTH"));

	// The logins the migration folded together, named by the person it made,
	// rather than by re-reading the admin flag now.
	//
	// The distinction matters, and it is not theoretical. This runs from
	// whichever request happens to arrive first after the deploy, which can be
	// long after it. Asking "who is an administrator?" at that moment would
	// sweep in an account created in between -- a second person, made an
	// administrator so they could keep their own addresses -- and hand them
	// every mailbox in the deployment as an owner, permanently, in rows that
	// look exactly like the ones that belong there. Asking for the person
	// instead cannot: an account made after the migration is given a person of
	// its own and is never in this set.
	//
	// Root is not in it either, and that is the whole point of root: it
	// manages accounts and owns no mail. It was not an administrator when the
	// migration ran, so the migration did not put it here.
	const rootUserId = await authDO.getRootUserId();
	const owners = (
		await authDO.listPersonLoginIds(LEGACY_ADMIN_PERSON_ID)
	).filter((id) => id !== rootUserId);
	const mailboxes = await listMailboxIds(env);

	let granted = 0;
	for (const userId of owners) {
		for (const mailboxId of mailboxes) {
			await authDO.grantMailboxAccessIfAbsent(userId, mailboxId, "owner");
			granted += 1;
		}
	}

	await env.BUCKET.put(
		MARKER_KEY,
		JSON.stringify({
			at: new Date().toISOString(),
			mailboxes: mailboxes.length,
			accounts: owners.length,
		}),
	);
	checkedInThisIsolate = true;

	return {
		ran: true,
		mailboxes: mailboxes.length,
		accounts: owners.length,
		granted,
	};
}

/** Test seam: the isolate-level memory has to be forgettable between tests. */
export function resetLegacyGrantMemo(): void {
	checkedInThisIsolate = false;
}
