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
 */
export async function personHoldsMailbox(
	env: Env,
	session: Session,
	mailboxId: string,
): Promise<boolean> {
	const authDO = env.MAILBOX.get(env.MAILBOX.idFromName("AUTH"));
	return (await authDO.getPersonMailboxes(session.userId)).includes(mailboxId);
}
