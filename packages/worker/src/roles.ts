/**
 * Who a signed-in person is.
 *
 * Two roles, and they are different in kind rather than in degree:
 *
 *  - **root** -- runs the deployment. Makes and unmakes the accounts of the
 *    people who use it. Holds no mailbox and reads no mail.
 *  - **admin** -- one of those people. Registers the addresses they use,
 *    reads their own mail, and sees nothing of anybody else's.
 *
 * There used to be a third, "member": somebody handed access to a mailbox
 * they did not register. Nothing ever created one on purpose. It existed
 * because the admin screen could make accounts that owned nothing, and it
 * gave the screen a word to print in a column -- so the role column showed
 * root, an account deliberately not carrying the admin flag, as the lowest of
 * the three. Removing the screen that made them removed the tier, and the
 * hierarchy is now two roles and, below them, mailboxes: not a third kind of
 * person.
 *
 * **The role belongs to a person, not to a login.** A person signs in through
 * any of several addresses, equal to each other, so that losing one does not
 * lock them out. Held against a login the role would die with that login, and
 * the way back would have to be somebody handing it over -- which on software
 * sold to customers means a button that gives a customer the deployment.
 * There is no such button. Held against the person, a spare login is the
 * whole of succession and recovery.
 *
 * It is an id rather than an address on purpose. An address can be changed by
 * its owner, and comparing addresses means normalising them -- fold the case,
 * trim the space, and then somebody wonders whether to strip a `+tag` and
 * quietly hands the role to a different account.
 *
 * How the first one comes to be:
 *
 *  - A deployment starts with no root, and every root-only route refuses
 *    everyone. That is the state a deployment upgrading into this begins in,
 *    and nothing about it is broken.
 *  - The first account ever registered becomes root, and there is no other
 *    way in. Nothing on the site offers to promote an existing account: a
 *    screen that hands out the top role is worth more to whoever finds it
 *    than to the person who deployed this, and this repository is public.
 *  - If every login of the root person is lost, what remains is the
 *    Cloudflare account, which reaches the storage directly. That is the same
 *    line every other guarantee here is drawn on; see the backup section of
 *    the README.
 */

export type AccountRole = "root" | "admin";

export function roleOf(
	personId: string | null | undefined,
	rootPersonId: string | null | undefined,
): AccountRole {
	if (rootPersonId && personId && personId === rootPersonId) return "root";
	return "admin";
}
