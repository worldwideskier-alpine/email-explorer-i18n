/**
 * The person the pre-existing logins were folded into.
 *
 * Two things have to agree about who the deployment's original person is: the
 * migration that first writes `users.person_id`, and the backfill that gives
 * the mailboxes that predate the grant model an owner. They describe the same
 * moment -- "everyone who was an administrator when this shipped is one
 * person, and the mailboxes already here are theirs" -- so they share a
 * constant rather than each deciding for themselves.
 *
 * Naming the set this way, rather than re-reading the admin flag when the
 * backfill happens to run, is what keeps a second person out of it. An
 * account created after the migration is given a person of its own and can
 * never fall into this one, however the flag is set on it in the meantime.
 */
export const LEGACY_ADMIN_PERSON_ID = "person-legacy-admins";

/**
 * What the auth object throws when a login would be made at an address
 * another person holds as a mailbox. Thrown rather than returned so that
 * `register` goes on answering a User, as the "UNIQUE constraint failed" it
 * sits beside does; the routes match it by this text and answer with the
 * sentence the dashboard already says in every language, "Mailbox already
 * exists".
 */
export const ANOTHER_PERSONS_MAILBOX = "Address is another person's mailbox";
