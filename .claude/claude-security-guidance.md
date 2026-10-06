# Security rules for this repository

A self-hosted email client on Cloudflare (Worker, Durable Objects, R2). AGENTS.md
explains each rule below at length; this is the checklist a review holds a
change against. Flag a change that breaks any of these.

## Permission boundaries

Every boundary is decided in the Worker, on the server, and the default is to
refuse. A screen hiding a button is never the control: a request typed by hand
does not go through the screen.

1. **Between customers.** A customer is a *person* (one or more sign-in
   addresses). A person reaches a mailbox only through a grant
   (`personHoldsMailbox`, `mailbox-access.ts`), asked by the gate in `fetch()`
   and by every mailbox-scoped route. Nothing else grants access: not the
   `is_admin` column, not the role, not knowing an id.
   - An id from another mailbox passed through one's own path (an email id,
     an attachment id, `raw/{id}.eml`, a backup name, a draft, a folder, a
     contact) must be refused, not served.
   - Mail is sent only as the mailbox in the path, with the sending key of the
     person whose mail it is. There is no fallback key.
   - A deleted mailbox's address stays its holder's: never given to another
     person while anyone holds it, or while mail or archives remain.
   - An address is one person's, whichever kind: no mailbox at another
     person's sign-in address, and no login made or moved to another
     person's mailbox, deleted ones included. Each is decided in the auth
     object's step that writes (`claimMailboxForPersonOf`, `register`,
     `registerFromForm`, `confirmEmailChange`, `giveMailboxToPerson`), not
     asked first in a call of its own. A password reset is not sent to an
     address another person holds as a mailbox, asked in the step that binds
     the link to that address (`passwordResetStamp`).
   - Push subscriptions, sessions and logins belong to one person; listing or
     removing them is scoped to the signed-in person.
2. **Between roles.** `root` above `admin` (`roles.ts`). Every
   `/api/v1/root/*` route is refused to everyone who is not root. Root is an
   id in `app_roles`; the first account to register becomes root inside
   `registerFromForm`, and no route may name, grant or transfer the role.
   Root owns no mailbox and reads nobody's mail.
3. **Demo, trial or staging systems.** None exist. A change that adds one, or
   a reset that could touch production data, is to be reported, not decided.
4. **Accounts published to visitors.** None exist. Registration closes once
   the first account exists, unless the deployment's own options open it
   (`registerEnabled`); a registrant is an untrusted user.
5. **Contract scope.** No plans or paid features exist.
6. **Contract state.** No suspension exists. Deleting a person ends their
   sessions, logins and push subscriptions at once, and takes their mailboxes
   and archives.

A new route is classified in `tests/integration/route-access.test.ts`
(public / session / holder / root) or that test fails. `PUBLIC_ROUTES` is an
exact-match list; a prefix match would make every later path public.
The cookie signs in only a GET of an attachment, `/docs` and `/openapi.json`.

## Keys

- A key the running system needs is a Worker secret (`wrangler secret put`),
  never a value in code, in a log, or in the `vars` of `wrangler.jsonc`,
  `wrangler.toml` or `wrangler.json`: `vars` are committed in plain text.
- Keys entered on a screen (a person's Resend key, a mailbox's Claude key, the
  Turnstile secret) are kept in R2 objects under `settings/` and
  `mailboxes/`, are never returned whole (only masked, `maskSecret`), and are
  never logged.
- `.dev.vars` and `.env` files are never committed; `.gitignore` holds them.
- Logs of this public repository's workflows are public. Every step that runs
  wrangler pipes it through `scripts/withhold.mjs`; nothing prints a token,
  an address or a mailbox name.
- Tests use placeholders only (`re_placeholder_for_tests`, the test-only VAPID
  key in `tests/vitest.config.mts`). A real key in a test is a finding.
- A line in `.claude/gitleaks-known-history` lets a key in main's history
  through the pre-merge scan. A new one names a commit already on main, under
  the reason for it, and is the owner's decision; one whose rule, file, line
  and commit are not in the pull request's description is a finding. So is a
  change that adds a `.gitleaksignore` or `.gitleaks.toml`, or that weakens
  `.claude/pre-merge-check.sh`.
- The pre-merge scan does not read what gitleaks' default config allows: lock
  files (`pnpm-lock.yaml`), images (SVG included), fonts, `node_modules`, a
  path with `gitleaks.toml` in it, and lines some rules accept. A key-shaped
  value a change adds to one of those is for review to find, and is a
  finding.
