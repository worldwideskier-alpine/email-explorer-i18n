import { ensureLegacyMailboxGrants } from "./legacy-grants";
import type { Env, Session } from "./types";

/**
 * Whether this session's person holds the mailbox.
 *
 * The single question every mailbox-scoped route asks. It used to be "does
 * this account carry the admin flag", which answered yes for every mailbox in
 * the deployment and so was not a question about this mailbox at all.
 *
 * It lives in a file of its own rather than in index.ts because the routes
 * split out of index.ts need it too, and index.ts imports them: asking for it
 * from there would put a cycle in the bundle for a two-line function.
 *
 * The backfill runs first, and that is not belt and braces -- it is what makes
 * the answer true on a deployment upgrading from the model where an
 * administrator reached every mailbox by skipping this check. Those mailboxes
 * have no owner row until the backfill writes one, so asking who holds them
 * before it has run answers "nobody", for everybody. It used to be triggered
 * only by listing the mailboxes and by the nightly run, which meant a route
 * reached before either of those -- a script posting a restore straight at the
 * import endpoint, say -- got a refusal that opening the dashboard once would
 * have prevented. Asking it here means every ownership question carries its own
 * precondition. It costs a HEAD once per isolate and returns immediately after.
 */
export async function personHoldsMailbox(
	env: Env,
	session: Session,
	mailboxId: string,
): Promise<boolean> {
	await ensureLegacyMailboxGrants(env);
	const authDO = env.MAILBOX.get(env.MAILBOX.idFromName("AUTH"));
	return (await authDO.getPersonMailboxes(session.userId)).includes(mailboxId);
}
