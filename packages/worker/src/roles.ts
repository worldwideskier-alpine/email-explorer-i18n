/**
 * Who a signed-in account is, above the level of a single mailbox.
 *
 * Three roles:
 *
 *  - **root** -- creates, edits and deletes the accounts below it. Its whole
 *    job is the account list; it owns no mailbox and reads no mail.
 *  - **admin** -- an ordinary person with several addresses. Makes mailboxes
 *    and hands access to them out.
 *  - **member** -- someone given access to a mailbox they do not own.
 *
 * These three are what the admin screen's role column has to show. It used to
 * derive the label from the `isAdmin` flag alone, which left root -- an
 * account that is deliberately not an administrator -- displayed as the
 * bottom of the three, the one thing it certainly is not.
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
 *  - The first account ever registered becomes root, and there is no other
 *    way in. Nothing on the site offers to promote an existing account: a
 *    screen that hands out the top role is worth more to whoever finds it
 *    than to the person who deployed this, and this repository is public.
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
