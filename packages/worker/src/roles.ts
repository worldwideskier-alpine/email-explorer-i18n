/**
 * Who a signed-in account is, above the level of a single mailbox.
 *
 * Three roles:
 *
 *  - **root** -- creates, edits and deletes the accounts below it. Its whole
 *    job is the account list; it owns no mailbox and reads no mail.
 *  - **admin** -- an ordinary person with several addresses.
 *  - **member** -- someone given access to a mailbox they do not own.
 *
 * **Root is an account id held in this application's own storage.** Not a
 * deployment variable, not an environment setting: this is software people
 * fork and deploy, and requiring them to go to GitHub to say who administers
 * their own mail would be a strange thing to ask. Every part of it happens on
 * the deployed site.
 *
 * It is an id rather than an address on purpose. An address can be changed by
 * its owner, and comparing addresses means normalising them -- fold the case,
 * trim the space, and then somebody wonders whether to strip a `+tag` and
 * quietly hands the role to a different account. An id is the account.
 *
 * How the first one comes to be, and how it survives:
 *
 *  - A deployment starts with no root, and every root-only route refuses
 *    everyone. That is the state a deployment upgrading into this begins in,
 *    and nothing about it is broken.
 *  - While there is no root, an administrator may name one, once, from the
 *    admin screen. That is not an escalation: an administrator can already
 *    make and unmake administrators, so it grants nothing they could not
 *    reach anyway. The moment root exists the door closes.
 *  - Root can hand the role to another account. That is the handover path,
 *    and it is also the recovery path, which is why it exists rather than
 *    being left to a database edit.
 *  - If root is lost entirely -- password gone, recovery address gone -- what
 *    remains is the Cloudflare account, which reaches the storage directly.
 *    That is the same line every other guarantee here is drawn on; see the
 *    backup section of the README.
 */

export type AccountRole = "root" | "admin" | "member";

export function roleOf(
	user: { id: string; isAdmin: boolean },
	rootUserId: string | null | undefined,
): AccountRole {
	if (rootUserId && user.id === rootUserId) return "root";
	return user.isAdmin ? "admin" : "member";
}
