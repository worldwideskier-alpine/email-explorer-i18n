/**
 * Who a signed-in account is, above the level of a single mailbox.
 *
 * Three roles:
 *
 *  - **root** -- creates, edits and deletes the accounts below it. Its whole
 *    job is the account list; it owns no mailbox and reads no mail.
 *  - **admin** -- an ordinary person with several addresses. Sees the
 *    mailboxes assigned to them and nothing else.
 *  - **member** -- someone given access to a mailbox they do not own.
 *
 * **root is decided by a deployment setting, not by a column in the
 * database.** That is the point of the design rather than an implementation
 * shortcut, and it buys two things:
 *
 *  - Nobody can take it from inside the application. There is no "make this
 *    user root" endpoint to find, no flag to flip with a stolen admin
 *    session. Becoming root means being able to change the deployment's
 *    configuration, which means the GitHub account -- a different door,
 *    guarded by somebody else's password.
 *  - It cannot be lost. If the root account's password is forgotten and its
 *    recovery address is gone, point ROOT_ADMIN_EMAIL at another address and
 *    redeploy. A flag in the database has no such way back: the last root
 *    locking themselves out would be final.
 *
 * The cost is that changing who root is takes a deploy. For a role that
 * changes when a business changes hands, that is the right price.
 */

export type AccountRole = "root" | "admin" | "member";

/**
 * How a login address is compared.
 *
 * Case is folded because registration does not fold it, so `Root@x` and
 * `root@x` can both exist as accounts and both must resolve the same way
 * against the configured address.
 *
 * A `+tag` is deliberately **not** stripped. `worldwideskier+admin@gmail.com`
 * and `worldwideskier@gmail.com` arrive in the same Gmail inbox, but they are
 * different accounts here, and that is exactly what makes one address usable
 * as two logins. Folding the tag away would silently make the ordinary
 * account root as well.
 */
export function normalizeLoginEmail(email: string): string {
	return email.trim().toLowerCase();
}

export function roleOf(
	user: { email: string; isAdmin: boolean },
	rootAdminEmail: string | undefined,
): AccountRole {
	const configured = normalizeLoginEmail(rootAdminEmail ?? "");
	if (configured && normalizeLoginEmail(user.email) === configured) {
		return "root";
	}
	return user.isAdmin ? "admin" : "member";
}

export function isRoot(
	user: { email: string; isAdmin: boolean },
	rootAdminEmail: string | undefined,
): boolean {
	return roleOf(user, rootAdminEmail) === "root";
}
