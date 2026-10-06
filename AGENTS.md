# Agents

Orientation for anyone — human or agent — working in this repository.

## What this is

A multilingual fork (73 languages, listed in
`packages/dashboard/src/locales/registry.ts`) of
[G4brym/email-explorer](https://github.com/G4brym/email-explorer), a
self-hosted email client that runs entirely on Cloudflare. It receives mail
through Cloudflare Email Routing, stores it in Durable Objects and R2, and
serves a Vue dashboard from the same Worker.

The fork ships by being forked and deployed to Cloudflare, not by publishing
to npm. Upstream owns the `email-explorer` package name, so there is no
release automation here.

## Deployment-specific values

Four values belong to one deployment and no other: the Worker's name, its R2
bucket, its VAPID public key, and the address account-recovery mail is sent
from. They have to live in `dev/wrangler.jsonc`, which is also a file this
repository keeps changing -- so a fork editing them by hand would collide with
every update it pulled.

They are therefore set as **GitHub repository variables**
(`WORKER_NAME`, `R2_BUCKET_NAME`, `VAPID_PUBLIC_KEY`,
`ACCOUNT_RECOVERY_FROM`) and written into the runner's copy of the config by
`scripts/apply-deployment-config.mjs` before the deploy. The checked-in file
keeps this deployment's values as working defaults, which is what
`wrangler dev` and the test pool read.

An unset repository variable arrives as an empty string, so **empty means "not
set"** and the default stands. A deployment that configures nothing -- this
one -- deploys byte-for-byte what it did before. `deployment-config.test.ts`
holds that property.

`ACCOUNT_RECOVERY_FROM` is the odd one out: it is normally **set on `/root`**
and kept in the bucket (`settings/account-recovery.json`), and nothing in
the source names one. It used to be a string in `dev/index.ts`, which every
fork inherited -- a fork that set nothing sent its resets as this
deployment's address and they never arrived. The order is the variable, then
`/root`, then an `EmailExplorer({ accountRecovery })` option; with none,
"forgot password" is off. See `src/deployment-config.ts`.

The Worker serves the push public key it derives from the private one
(`publicKeyOf`, `routes/push.ts`), so `VAPID_PUBLIC_KEY` is only the fallback
for a private key written without its public point: a fork that set only its
own private key used to hand out this deployment's public key, and every push
was refused. A value given for it must have a key's shape, or the deploy stops.

The private key is set nowhere. The deploy asks the Worker's secret list
(names only) and, when `VAPID_PRIVATE_KEY` is not in it, makes a key on the
runner and hands it straight to `wrangler secret put` (`scripts/push-key.mjs`,
the step "Give the Worker a push key if it has none"). A Worker that has one
keeps it, and so does one whose list could not be read: a key put over an
existing one silently stops every device subscribed under it. It used to be a
GitHub secret uploaded on every deploy, which kept a copy on GitHub and left a
fork that skipped making one with no push; that copy is read by nothing now,
and the deploy warns while it exists. Only whether it is set reaches a step.
The step never fails the run, since the new code is live by then and a
failure would roll it back for a key. `push-key.test.ts` holds what it
decides and the words it is told (`pushKeyStep`; `push-key-step.mjs` only
moves bytes); `workflowGuards.test.ts` holds that the key reaches only
`secret put`, only whole, and is never echoed, teed, traced or written down
-- it is not a GitHub secret, so nothing would mask it in the public log --
and that every line of the step is one `bash -e` cannot end it on.

User-facing setup lives in `docs/deploying-your-own.md`.

## Layout

A pnpm workspace. There is no source at the repository root.

```
packages/worker/       The Worker: Hono + chanfana API, MailboxDO, mail ingestion
  src/index.ts         Route table, the fetch/email entry points, the auth gate
  src/durableObject/   MailboxDO -- one instance per mailbox, plus the AUTH singleton
  src/routes/          Handlers split out of index.ts (auth, push, drafts, ...)
  src/password.ts      PBKDF2 hashing and verification
  src/throttle.ts      Rate-limit policy for login and password reset
  tests/               Vitest on @cloudflare/vitest-pool-workers
  dev/                 THIS deployment: wrangler.jsonc and EmailExplorer() options
  scripts/             Deploy-time tooling, run by node, not bundled
packages/dashboard/    The Vue 3 SPA, built into the Worker's assets
  src/locales/         the 73 message catalogues, and registry.ts naming them
  src/**/*.test.ts     Vitest on jsdom
docs/features/         User-facing guides, linked from the README
docs/deploying-your-own.md  How someone forks this and runs their own
```

`packages/worker` is the reusable package and carries no deployment-specific
values. `packages/worker/dev` is this deployment, and does.

There is no `template/`. Upstream keeps one -- a starter whose package.json
installs `email-explorer` from npm -- and it was inherited here, where it was
actively misleading: that package is upstream's, so it carries none of this
fork's work. This fork ships by being forked.

For the same reason nothing builds a package any more. `packages/worker/dev`
imports `../src` and wrangler bundles it from there; the `dist/` that tsup used
to produce for npm was read by nothing, and tsup had stopped taking releases,
which left an esbuild advisory it could not accept. The worker's `build` only
copies the dashboard into `packages/worker/dashboard`, the directory the
deployment's assets come from, and `private: true` keeps it off npm. The types
are still checked, by the `tsc` that runs before the worker tests.

## Key concepts

- **MailboxDO.** One Durable Object per mailbox, holding that mailbox's
  emails, folders and contacts in SQLite (through `workers-qb`) so everything
  for one mailbox is co-located. A separate singleton, addressed by the name
  `AUTH`, holds users, sessions, mailbox grants, push subscriptions and the
  rate-limit counters. Which of the two an instance is decides which set of
  migrations it applies — see the constructor.
- **Inbound mail.** The `email()` handler files a message by its *envelope*
  recipient (`event.to`), never by the `To:` header, and rejects anything
  addressed to a mailbox that does not exist. Trusting the header let anyone
  create a mailbox by sending mail to one.
- **The auth gate.** `route-access.test.ts` holds one table of every route
  the Worker registers -- public, any session, mailbox holder, root -- and
  asks each the same questions. A new route fails it until it is put in the
  table, which is the point: its gate is decided on purpose.
  `fetch()` validates the session before Hono routes
  anything. `PUBLIC_ROUTES` is the exact-match allowlist of what may be
  reached without one — exact, because a prefix match silently makes every
  future path starting with a public one public too. Static assets never
  reach the Worker at all: `run_worker_first` in wrangler.jsonc sends only
  `/api/*`, `/docs` and `/openapi.json` here.
- **API schema.** Generated at runtime by chanfana from the route classes.
  There is no checked-in `openapi.json`, and `/openapi.json` needs a session.
- **Sending.** Outbound mail goes through Resend, not Email Routing, with
  the key of the person whose mail it is (`app-settings.ts`, `resend.ts`):
  a mailbox's mail with its holder's, a password reset or address-change
  confirmation with that person's, root's own with root's. Each sets theirs
  on their own screen -- `/admin`, or `/root` for root, through the same
  `ResendKeyCard.vue`. There is **no fallback**, and a rewrite that adds one
  back undoes the point: the deployment-wide key from before keys were per
  person and a `RESEND_API_KEY` Worker secret both used to be read, both sent
  somebody's mail with a key that was not theirs, and the first was the only
  way root's reset mail could leave, because root had nowhere to set a key
  and no screen showed it. `resend-settings.test.ts` holds it; tests that
  send give their sender a key (`giveSendingKey`), as a real one would.
  The tests' Resend stub refuses a request with no key, as Resend does, and
  records what it took with whose key (`https://api.resend.com/__sent`);
  `whose-key.test.ts` asks it. Before, it took anything, so a send billed to
  somebody else passed every test.
- **Roles.** `root` / `admin`, decided in `roles.ts` -- the third, `member`,
  is gone (nothing ever made one on purpose). Root is an
  **account id in `app_roles`, inside the auth Durable Object** -- not a
  deployment variable. This is software people fork and deploy: naming who
  administers their own mail must not send them to GitHub, so every part of it
  happens on the deployed site. A deployment starts with no root and every
  `/api/v1/root/*` route refuses everyone; while there is none,
  **the first account to register is root**, and that is the only way one
  comes into being -- decided inside `registerFromForm`, in the same step that
  inserts the account, and reachable from no other route. An endpoint that named a root, however well guarded, would
  read as "somebody may take the tier above them" on every deployment of this
  that exists. The role does not move afterwards either: `transferRoot` is
  gone, and succession is root adding a second address to **their own
  person** (`PostAccount` with `role: "root"`), a spare rather than a second
  root. On software with customers, a button that hands the role on is a
  button that gives a customer the deployment.
  Root owns no mailbox, is left out of the `GetMailboxes` administrator view,
  and its screen does not list anyone's mailboxes: what an administrator does
  with their own addresses is not root's business.
- **Deletion locks, both of them.** A mailbox has one (`isDeletionLocked`,
  `mailbox-settings.ts`) and a person has one (`isPersonDeletionLocked`,
  `app-settings.ts`); both default to *on*, including for anything stored
  before they existed, because the only safe reading of an absent flag is
  "protected". Neither is a permission — whoever can delete can also unlock —
  and describing them as security would be the wrong claim. What they buy is
  that an act nothing undoes takes two deliberate steps instead of one touch,
  which is what "delete this person" needed: it takes their logins, their
  mailboxes, the mail in them, the raw copies, the attachments and every
  nightly archive. Both are enforced in the Worker with 423, not on the
  screen: the screen hides the button, and a request typed by hand does not go
  through the screen. Whether a person exists is decided *before* whether they
  are locked, because an absent lock reads as locked and asking in the other
  order answered "this person is protected" about an id with a typo in it.
  The person locks live in one object of their own (`settings/person-locks.json`),
  not beside anybody's Resend key: before writes were conditional, sharing an
  object let a lock being moved clobber a key being saved. Reads of that map swallow failure and answer
  "everyone locked" (safe, and it keeps one bad read off the account list);
  **writes must not** -- a read-modify-write on a swallowed `{}` puts back a
  map holding one person and answers 200, which is the same loss with a
  cheerful face. The writers go through `rewriteJson`, which throws on a
  failed read; the forgiving read wraps `readLocksToWrite`.
  A person's deletion removes the account rows first, so a mailbox whose own
  object then could not be wiped was beyond reach -- asking again answered
  404, and its messages stayed. It is answered 500, written down
  (`maintenance/unfinished-deletions.json`) and finished by the nightly run,
  last in the order and within its own deadline (`finishUnfinishedDeletions`).
- **A shared R2 object is rewritten conditionally.** A mailbox's settings
  object has four writers -- a save, a spam verdict, the nightly backup and
  purge -- and each put back the whole object it had read, so two at once
  left only the second. `rewriteJson` (`r2-json.ts`) puts only if the object
  is still the one read (its etag) and otherwise makes the change again on
  what the other writer left. R2 does have that; an earlier note here said it
  did not. Settings saves also merge onto what is stored, so a save carries
  only the section it changes.
- **A secret that is not a password is a `SecretInput`**, never
  `type="password"`: an API key, the Turnstile secret. A password box makes
  the browser take its form for a sign-in form -- it filled root's own address
  and password into the Turnstile keys, and it offers to save an API key as
  this site's password, which it then fills into sign-in. `SecretInput.vue` is
  a text box masked by CSS (`-webkit-text-security`; measured masking in
  Chromium 141, Firefox 142 and WebKit 26 with the production stylesheet) with
  the password managers' ignore attributes.
  `secretInputs.test.ts` holds that every `type="password"` box in the
  dashboard says `current-password` or `new-password`, so a new key field made
  as a password box fails there.
- **Switches.** Never `<input type=checkbox :checked="…">`: the browser owns a
  checkbox's `checked` and flips it before any handler runs, while Vue writes
  a DOM property back only when the *bound* value changed -- so dismissing a
  confirmation left the switch showing the click rather than the data. Use
  `ToggleSwitch.vue`, which is a `role="switch"` button with no state of its
  own. `v-model` switches are *not* affected and several remain: that
  directive writes `el.checked` from the model on every update. Both halves
  measured rather than reasoned about; `toggleSwitch.test.ts` mounts for real,
  because the fault was invisible in the source and a source-text assertion
  about it passed while a screen was wrong.
- **Decide and act in one Durable Object call.** A Durable Object runs other
  requests while one awaits, so anything a route asks in one call and acts on
  in the next is decided for every request that arrived in between. Measured
  twice: 25 wrong passwords sent at once were all verified (the limit is 10)
  because the route asked "locked?", verified, then recorded; and four
  registrations to a new deployment all got in, because each was told it was
  first. Registration also asks whether it is closed *before* hashing the
  password (a smart-mode form is closed once root exists, and each refusal
  cost a PBKDF2 in the object every sign-in waits on), and each address gets
  ten attempts an hour (`registerThrottleRules`, `register-cost.test.ts`).
  `throttleTake` checks and counts in one call, and a success hands
  back what it should not have cost through `throttleSettle` -- per rule:
  the account's key resets, the IP's key (shared by every account behind it)
  gets back only that attempt. `auth-concurrency.test.ts` holds both.
  Creating a mailbox is the same shape: the address is claimed in one call
  to the auth object (`claimMailboxForPersonOf`) before anything is written,
  because two people creating the same new address at once both got it.
- **A stranger's failed sign-ins lock out strangers, not the owner.** The
  per-address limit (ten in fifteen minutes) is what holds a password
  against guesses from many networks, and it also let anyone who knew an
  address lock its owner out with ten wrong passwords every fifteen minutes,
  for as long as they kept sending them -- measured, three rounds running.
  Root's too: Turnstile is off until root sets it, and a root locked out
  with no live session could not reach the screen that turns it on. A
  browser that has proved the password is now counted on a key of its own
  (`login-device.ts`, OWASP's device cookies): a random `login_device`
  cookie, sent only to the sign-in route, kept as a digest in
  `login_devices` and bound to the login's `credentialStamp`. Everything
  without it -- every network, every new browser -- still shares the
  address's ten, and the network's thirty holds for a trusted browser as
  for anyone. Five things a rewrite could quietly undo. The standing is
  granted inside the call that verified the password (`login`,
  `changePassword`, `resetPasswordWithStamp`), never in a later one:
  granted afterwards, sign-ins racing a password change stayed trusted
  under the new password, ten of ten. The token is replaced at every
  sign-in and the one presented retired, so a copied cookie dies at the
  owner's next sign-in, and 100 failures on one end it
  (`DEVICE_FAILURE_CAP`). `loginTake` decides "trusted" and counts the
  attempt in one call, as `throttleTake` does. A trusted browser's success
  resets its own key and not the address's, so the stranger stays locked
  out. And the rows are deleted by what ends them -- ending sessions, a
  confirmed address change, deleting a login or a person -- rather than
  left to the stamp: a login moved to another address and back has its old
  stamp again, and the browsers from before were trusted again without
  signing in. `login-device.test.ts`.
- **Turnstile guards the forms a stranger reaches** -- sign-in, registration,
  the reset request -- once root sets it on `/root` (`turnstile.ts`, kept in
  `settings/turnstile.json`). A pair is saved only after it passed siteverify
  on that screen (`PostTurnstileVerify`, then `PutTurnstile` checks it is the
  same pair): saved unchecked, a wrong one refuses every sign-in, root's with
  them, and the screen that undoes it is behind the sign-in. For the same
  reason `invalid-input-secret` -- a secret Cloudflare no longer knows, which
  no visitor can bring about -- lets requests through. A request with no token
  is asked with a stand-in (`NO_TOKEN`): measured from a GitHub runner,
  siteverify asked with no token answers only `missing-input-response` and
  never says the secret is unknown, so a widget deleted in the dashboard --
  which renders nothing, so sends nothing -- locked everyone out. The tests'
  stub answers in Cloudflare's measured order; an earlier one did not, and the
  test for that case passed against it. A siteverify that does not answer, or
  answers `internal-error`, lets the request through as well, logged: an
  outage of Cloudflare's refused every sign-in, root's included, for as long
  as it lasted. The check runs before the
  throttle, so a bot without a token spends nobody's attempts. Registration
  starts the session itself: the form used to call `/login` next, which would
  need a second token. `turnstile.test.ts`; the tests' siteverify stub passes
  `PASS:<secret>` only.
- **Adding or removing a sign-in address asks for the password.** It outlasts
  the session it is done from: with a session alone, a thief added a login of
  their own to the owner's person, which a reset of the owner's password does
  not touch. The same holds for root's spare (`PostAccount` with `role:
  "root"`), which is the role for good. `proveCurrentPassword` in
  `routes/auth.ts`, under the account-change limit; `own-logins.test.ts`.
  Moving a login to another address is confirmed by a mailed link, and the
  link is bound to the password and address as they were when it went out
  (`emailChangeStamp`): unbound, a link asked for by someone holding the
  password survived the owner changing or resetting it, and moved the login
  to their address anyway. `account-management.test.ts`.
  A reset link is bound the same way (`resetPasswordWithStamp`): it dies with
  a password change, and two uses at once no longer both get through.
  Setting a Resend key asks for the password too -- with a session alone a
  thief put in a key of their own and read the owner's mail in their Resend
  dashboard -- and `ResendKeyCard` puts a `username` box holding the
  account's own address before its password box, so a browser pairs the real
  sign-in and not the key. Confirmation mail is counted on keys of its own
  (`account-mail:`): sharing the guessing keys, any right password elsewhere
  cleared it (`account-mail-limit.test.ts`).
  What an answer says without meaning to: a sign-in to an unknown address
  spends a PBKDF2 all the same (`verifyNothing`), a reset request answers
  before its token and mail, which go in `waitUntil`, and the auth object not
  answering is a 503, not the 401 the dashboard signs out on
  (`auth-quiet-signals.test.ts`).
- **Ending a session ends its push subscription.** A notification carries
  the sender and subject of each new message, so a subscription is bound to
  the session that registered it and delivered to only while that session
  lives; a password change, a reset and root setting a password end the
  others with their sessions. The dashboard hands the browser's subscription
  to each new session (`rebindPushSubscription`), since the browser keeps it
  and the settings switch reads it from there. `sessions-end.test.ts`.
  A subscription made under a key the Worker no longer serves is made again
  under the one it does, first -- the old endpoint forgotten by the Worker,
  and only then let go by the browser -- because a push service refuses a
  push signed with any other key, and a replaced key (see Deployment-specific
  values) would otherwise leave every device subscribed, switch on, receiving
  nothing. Only when both keys are known and differ. That a browser lets a
  page subscribe again without a tap was read from WebKit's source, not tried
  in a released browser; one that refuses leaves the switch off.
  `pushRebind.test.ts`.
- **Threading uses the sender's Message-ID.** Ingest keeps it in
  `message_id`; a reply names it in In-Reply-To and References, and never a
  row id, which no other client has seen (`replyThreading`,
  `routes/reply-forward.ts`). Mail sent from here has none we know -- Resend
  assigns it and does not say -- so a reply to it carries no In-Reply-To and
  keeps the thread through References.
  An id is the sender's string and a reply writes it into two headers, so it
  is kept only if it has an id's shape (`asMessageId`, `message-id.ts`):
  postal-mime decodes RFC 2047 in those headers, and an encoded CR LF came out
  as a real line break -- a `Bcc:` of the sender's choosing in our next reply.
  Asked at ingest, when a reply is threaded and when the headers are written,
  since rows from before are still there. `message-id-shape.test.ts`.
  The list marks a message answered from here (`replied_at`, set by the
  reply route once Resend has taken the reply, never on a refusal or a
  forward). Replies from before the column were found by the copy each left
  in Sent, whose In-Reply-To names the message -- by Message-ID, or by our row
  id from before replies were threaded that way (`13_replied_at`,
  `replied-mark.test.ts`). A forward is marked the same way on its own
  column (`forwarded_at`), with the arrow the other way round
  (`SentOnMarks.vue`); forwards from before it have no mark, because the copy
  a forward keeps in Sent names no message it came from.
- **A notification is dismissed only if it was sent.** Delivery sets
  `notified` when a device was told; mark-read, delete, bin and "spam" ask
  `takeNotified`, which clears it in the same step. A dismissal is a push that
  shows nothing, and sending one for mail no device had seen is how a browser
  comes to withdraw the subscription.
- **Mailbox ownership.** A grant says who a mailbox belongs to, and it is the
  only thing that grants access: the middleware in `fetch()` and every
  mailbox-scoped route ask `personHoldsMailbox`, and the mailbox list filters
  by the same grants. The administrator bypass this replaced — an account
  carrying `is_admin` skipped the check and reached every mailbox — is gone,
  and `legacy-admin-flag.test.ts` holds that the flag buys nothing, because
  the column is still written and `if (session.isAdmin)` would compile
  anywhere in the request path. The mailboxes in daily use predate the grant
  model and had no rows at all; `legacy-grants.ts` backfilled them once, which
  is what made removing the bypass survivable.
  A grant also outlives the mailbox's deletion, purged or not, and that is
  what keeps the address its holder's: the archives a purge leaves on purpose
  are theirs, and so is the mail a plain delete keeps. `PostMailbox` gives an
  address to nobody else while anyone holds it, and to nobody at all when
  nobody does and mail or archives remain -- it used to check only whether a
  settings object existed, and a second person registered a deleted address
  and read the first one's mail and archives. A delete keeps the settings in
  `mailboxes-deleted/{id}.json`, for the holder's recreate to start from:
  without them the backup count came back at the minimum and a recreate was a
  way round the rule that it only rises. `mailbox-boundaries.test.ts` holds
  all of this, and also that an original (`raw/{id}.eml`, named by id alone)
  is read or deleted only through the mailbox whose message it is, and that
  mail is sent only as the mailbox in the path.
  A mailbox being destroyed is **closed** first (`closeMailbox`,
  `12_mailbox_closed`) and `createEmail` refuses a closed one in the same
  step as its write. Delivery checks the settings object and writes seconds
  later (the spam check is between), and a deletion in that gap wiped the
  object and then took the message: mail nobody held, an address nobody could
  create again, bucket objects nothing named. Ingest takes back what it put
  in the bucket when refused, and `PostMailbox` reopens.
  `mailbox-closing.test.ts`. A person's deletion writes all their mailboxes
  down as unfinished before removing anything, and the nightly run leaves
  alone an address that has a settings object again -- somebody created it
  since, and the run used to destroy their mailbox.
  Holding a deleted mailbox is not enough to act on it: the gate in `fetch()`
  answers 404 for a mailbox with no settings object, and so does the import
  route, which sits outside the gate. Anything that wrote a settings object
  for a deleted mailbox -- a spam verdict, a restore, ingest's old
  auto-create -- brought it back from nothing, backup count at the minimum.
- **One spelling per address.** Mailbox addresses and sign-in addresses are
  trimmed and lowercased on the way in, and sign-in looks up without case
  (rows from before are still found by either spelling). Stored as typed, a
  capitalised copy of somebody else's mailbox was a second mailbox that could
  send as the first, and a capitalised mailbox received nothing, since inbound
  mail is filed by the lowercased envelope recipient.
- **One person per address, whichever kind.** A reset link goes to the
  sign-in address, and mail to an address is filed in the mailbox of that
  address, so whoever holds the mailbox reads the link. Mailbox creation
  looked only at the grants and login creation only at the logins: a mailbox
  registered at somebody else's sign-in address took their account (root's
  too), and root making a login at a customer's mailbox handed the customer
  that login. Now creating a mailbox refuses another person's sign-in
  address (`claimMailboxForPersonOf`), and making or moving a login --
  root's form, one's own spare, the open registration form, the address
  change when confirmed -- refuses another person's mailbox, deleted ones
  included, since a grant keeps the address its holder's. Each of those is
  decided in the auth object's step that writes, both tables being there.
  The address change is also refused when it is asked for, so the link is
  not mailed into somebody else's mailbox; that is an early answer, and the
  confirmation has the last word. The legacy backfill passes such an
  address over (`giveMailboxToPerson`), and a run that passed over
  everything it found is not run again (`passedOverEverything`). Addresses
  compare without case: sign-in rows from before lowercasing keep capitals.
  One's own addresses are left alone, and a holder may still bring back a
  deleted mailbox that collides with a login from before.
  Those collisions are not undone -- neither side can be removed safely --
  so a reset is not sent to an address another person holds as a mailbox;
  the answer is the one any address gets, and root can set the password
  directly. That is asked in the step that binds the link to the address it
  is mailed to (`passwordResetStamp`): asked in a call of its own before the
  stamp, the owner could move off the address in between, somebody make a
  mailbox of it, and the link -- stamped with the new address -- reset the
  owner's password from there.
  Root is a person of its own, so root's sign-in address is somebody else's
  to every administrator account, the owner's own included: a mailbox at
  root's address is refused even where one human runs both, and where such
  a mailbox exists from before, root's reset is not sent to it. The setup
  guides say so, and to give root a spare.
  Refusals reuse "Mailbox already exists", which every catalogue already
  has, so no sentence says which kind of address was met -- but the refusal
  itself says something. A signed-in administrator can learn from a 409 at
  `POST /mailboxes`, with no password and no limit, that an address is
  somebody's sign-in address (root's included) or a deleted mailbox --
  inbound mail is refused where no mailbox lives, which rules out a live
  one -- though every guess that misses becomes a mailbox of theirs.
  Before, telling a sign-in address took the current password, under the
  account-change limit. That is the price of refusing at all: a mailbox
  that is let through is the hole.
  Nothing proves an address is its taker's, so it can also be held to keep
  it from someone. An administrator can make a mailbox at any address -- one
  at another provider, which never delivers here, as readily -- and delete
  it, and the grant left behind keeps every other person's login, as well
  as their mailbox, off that address until its holder is deleted; root,
  which sees nobody's mailboxes, is told only "Mailbox already exists" and
  not by whom. The other way round, a registration form open to everyone
  lets a stranger sign in at an address meant to be a mailbox here, which
  root at least sees in its list of people and can delete. Telling an
  owner from a squatter would take proof of ownership, a flow of its own,
  so neither is undone in code; the admin guide says what root is told.
  `address-of-another.test.ts`.
- **The daily cron.** One `scheduled()` handler, which starts every
  mailbox's night in that mailbox's own Durable Object alarm, all at once
  (`mailbox-night.ts`), and waits to write down how they went
  (`scheduled-run.ts`). The order inside a night matters: it backs the
  mailbox up *first* and deletes old spam *second*, so a message the purge
  removes is already in that night's archive. Reversed, the deletion would be permanent with no copy anywhere.
  Nothing in the types holds it; `scheduled-order.test.ts` does.
  The order is not enough on its own, though: tonight's archive may not exist
  (the backup failed, was cut off, or a weekly or monthly one was not due).
  So for a mailbox with backups on, the purge deletes only what arrived before
  the newest archive in the bucket (`newestArchiveAt`), and nothing while
  there is none; `spam-purge.test.ts` holds it. "Arrived" is `received_at`,
  stamped at ingest, never `date`: a restored message carries its own date,
  years back, and by that it counted as archived when no archive held it.
  Expiry is a third clock, `spam_since`, set when a message enters spam and
  cleared when it leaves: counted from `date`, an old message filed as spam
  today was deleted the same night.
- **The nightly run has to survive being cut off**, because it was not. On
  2026-09-04 the whole record was `{"startedAt":"2026-09-03T18:14:09.407Z"}`:
  `scheduled-run.ts` writes `backups` whether the pass returns *or throws*, so
  its absence means the runtime killed the invocation inside the backup pass.
  No archive for two nights, and the purge — second in the order — had never
  once run. One fault, three symptoms, and each screen only showed its own.
  Two things came out of it that a rewrite could quietly undo:
  `backup-writer.ts` reads messages a page at a time (one Durable Object round
  trip per message was over 1500 per invocation, plus one R2 read each), and
  the run reports progress as it goes into `MaintenanceRecord.backupProgress`,
  which is the only thing a killed run leaves behind -- now the backup
  furthest from done. `backup-pass-progress.test.ts` holds both.
  It was cut off again on 2026-09-22, differently: `exceededWallTime` at
  899968 ms with 716 ms of CPU -- fourteen minutes waiting on one call that
  never answered. Both mailboxes lost that night's archive, each left an
  upload open, the purge never ran, and the next night overwrote the record,
  so it was found five days later by reading R2 by hand. So now **nothing in
  the run waits without a limit** (`deadline.ts`): each call a minute, the
  backup done by twelve minutes in, the purge by thirteen; a mailbox whose call
  does not answer fails alone, its upload aborted and the reason on its
  settings. A call cut short by that end is recorded as `out-of-time`, not
  as a call that "did not answer" (`OutOfTime.passEnded`). And each run moves
  the previous record into `maintenance/history.json` (two weeks) before
  writing its own, which `/root` lists when a night did not end well.
  `nightly-limits.test.ts` holds both, with that night's own record.
  The spam purge is held the same way, call by call, and recording after a
  deadline has an end of its own (`recordBy`). `nightly-purge-limits.test.ts`.
  Those limits used to be the whole pass's, every mailbox one after another
  inside the cron's one invocation, and on 2026-10-01 that was the fault: a
  slow first mailbox spent the time, and the second was cut off 300 messages
  in. So each mailbox's night is now its own alarm with the whole of its own
  time, and a slow mailbox costs nobody else theirs (`nightly-limits.test.ts`,
  two that hang and one that finishes, in about one night's time). An alarm
  has the cron's fifteen minutes of wall time but only 30 seconds of CPU,
  where the cron had fifteen minutes, and a mailbox does not stop growing
  (1756 messages and 401 MB on 2026-10-01). Nobody should have to watch for
  the night it no longer fits, so **a backup is written in slices**
  (`SLICE_BYTES`, 128 MiB or eight minutes, `backup-writer.ts`): a slice
  pauses with its upload open, keeps its place and the bytes that are not yet
  a whole part in `backup-carry/{id}.*` -- outside the archives' prefix, which
  the holder's screen lists and the purge reads -- and the night sets the
  next alarm and carries on (`continuing`). The archive is byte for byte the
  one a single pass writes, and `backup-slices.test.ts` holds that, with the
  carry given up when the runtime ends a slice, when a night would run into
  the next one (`MAX_SLICES`), and when the mailbox is deleted. The cron
  only starts the nights and polls (`nightStatus`) for up to fourteen
  minutes; one still carrying on then is listed in the record as
  `continuing` rather than counted as failed, and counts itself in when it
  ends (`foldContinuedNight`), which is also why the cron's own writes keep
  what the nights folded in. `/root` says how many are still going beside
  the finished line (`maintenanceContinuing`), so a smaller count does not
  read as the whole night. An alarm the runtime ended partway is run again by the
  runtime; the second attempt finishes the record -- failed, due again
  tomorrow -- rather than the night, which would most likely end the same
  way once per retry (`night-alarm.test.ts`). A test that hands the run an
  `env` of its own passes `nights: inlineNights`, since an alarm runs with
  the deployment's.
- **An attachment object is reachable only through its row.** Every writer
  names one `attachments/{emailId}/{attachmentId}/{filename}` and every reader
  — download, archive, delete — rebuilds that name from the row, so an object
  the rows do not name cannot be opened, will not go into an archive, and
  outlives the message it belonged to. `attachment-sweep.ts` is root's screen
  for that, and the two states it separates are not the same thing:
  **misnamed** means a live row names this attachment under another name (the
  ingest defect that wrote `.../null` while recording `untitled`), and those
  are *moved*, because deleting them destroys somebody's attachment;
  **unclaimed** means no row names it at all, which is what a deletion that
  stopped halfway leaves — and also what a mailbox deleted *without* `purge`
  looks like from outside, since its mail is meant to come back. Nothing can
  tell those two apart from the bucket, so deleting them is a separate press
  with that said on the screen.
  The row also carries the attachment's **charset**, which postal-mime does
  not give: it hands back a bare `text/plain` with the parameters gone, so a
  Shift_JIS file was indistinguishable from a UTF-8 one from ingest onwards.
  `attachment-charset.ts` reads the declaration back out of the raw message
  while ingestion still has it, pairing the parser's attachments with the
  parts of the message — and recording nothing at all when those two readings
  disagree, because a wrong charset is a worse answer than no charset.
- **The second-stage spam check runs in the Durable Object**, not in the
  `email()` handler, and that is about geography rather than storage. A Worker
  runs at the data centre that received the message and Email Routing's MX
  addresses are anycast, so the receiving data centre follows the *sender* --
  which meant the call to Anthropic left from a different place for every
  message. Measured on the live mailbox: refused at `...-HKG`, worked at
  `...-FRA`, same key. Hong Kong is not on Anthropic's published list of
  supported regions, so the check was passing or failing according to where the
  spam had been sent from. A Durable Object is one instance in one place, so
  calling from there makes the path the same for every message; it does not
  choose *which* place, and `spamCheck.lastSuccessVia` on the settings screen
  is what says where it settled. `MailboxDO.checkSpam` also writes the health
  record, so a check and its record cannot come apart.
  `spam-check-location.test.ts` holds the arrangement -- partly structurally,
  because both sides run in one isolate under the test pool and the difference
  is only visible in production.
- **The spam check reads the part the screen shows, as a browser reads it.** The
  screen shows a message's HTML part whenever it has one (`email-ingest.ts`),
  and the classifier read its text part whenever it had one -- so an innocent
  text part beside a phishing page in the HTML was all the classifier was
  asked about. `buildClassificationContent` (`claude-spam-filter.ts`) now puts
  the HTML's words first, and the text part after them with 1000 of the 4000
  characters kept for it: neither part can push the other out by being long,
  a picture-only HTML part has no words of its own, and a link's address is
  spelled out only in the text part. The HTML is read the way the tokenizer
  reads it (`stripHtml`), because any reading that differs is the same trick
  again: the expressions before took a visible `5 < 6`, `<scripts>` or
  `alt="<style>"` for the start of something and dropped the words after it,
  and a scan that ended a script at its first `</script>` was undone by forty
  bytes -- inside a script, `<!--` and then `<script` move its end to a later
  `</script>` (`scriptEnd`). So `<` opens a tag only before a letter, `/`,
  `!` or `?`, a quoted value keeps its `>`, raw text ends at its own end tag,
  a script where the tokenizer's script states end it, a comment where the
  tokenizer ends it, references are decoded (legacy names with no semicolon
  too) and invisible padding is taken out. A comment's far side, past its
  first `>`, is read as it was before -- `<!--[if mso]>` blocks give their
  words -- but as markup of its own that stops at the comment's end, so
  nothing in it hides what follows. Inside svg and math a style or script is
  read rather than dropped, since the tree builder does not make it raw text
  there. Inside select a style is read, which the tree builder makes no
  element of, and so is a script, which it does and the browser hides: it
  ignores a title or an xmp in select, so the reading there is less sure, and
  dropping the script where it went wrong lost the words after it, measured.
  The rest of the tree builder is not followed. Words meet where the screen
  runs them together -- a comment, a doctype, `<wbr>` and NUL part nothing --
  but every element's tag parts them, even an inline one that does not on
  screen, since style can make any element a block: an empty `<span></span>`
  inside a word still splits it in two. Against parse5 on random markup,
  compared with the white space taken out of both -- so a word split in two
  still counts as read -- it missed none of the words a browser shows in
  1,355,830 messages without svg, math or select, script escapes among them.
  With svg or math it missed 496 of 555,140, and with select 105 of 89,030 --
  most of them a word written as references inside an element that is raw
  text in HTML and markup there. The reading before missed a third of them
  (`strip-html.test.ts` holds a generated version). It stops once it has the
  4000 characters, a step of 4096 at a time: decoding the whole of a 24MB
  message cost seconds of the mailbox Durable Object's time. The sender's
  `<` and `>` become `‹` and `›` -- one for one, so the limit still holds;
  `&lt;` grew a body of `<` to four times it -- so nothing they write closes
  `<shown_to_reader>` or `<plain_text_alternative>`, and the relay's
  Authentication line is the only line above the `----` marker. The system prompt explains every tag the
  content uses, and a test holds the two together. Gaps known rather than
  overlooked: text the HTML hides by style, puts in a `<title>` or leaves on
  a comment's far side is read, so three thousand characters of it ahead of
  the visible words leave them out (taking it out needs the page laid out,
  not parsed); inside
  svg, math and select a crafted message can still part this from the
  browser, as the counts above say; and words the screen draws rather than
  holds -- an image's `alt`, an input's `value`, a style's `content`, a
  picture of the words -- are not read, so an HTML part that shows its words
  only that way, beside an innocent text part, still leaves the classifier
  the text part alone (the prompt says what the part it is shown leaves
  out). Reading the first three would still leave the picture, which costs a
  sender no more and which no reading of the markup sees, and would add text
  nobody is shown: an `alt` is not shown once its picture loads.
  A text-only message is read as its `pre-wrap` block shows it
  (`plainShown`): what takes no room is taken out and each run of spaces or
  blank lines is one, a step at a time -- read as it came, four thousand
  zero-width spaces, or line breaks, ahead of its words left them out. A run
  two steps cut is joined where they meet: left as two, a body of line
  breaks counted a blank line per step towards the 4000 and stopped before
  the words.
  `claude-spam-prompt.test.ts`, `strip-html.test.ts`,
  `claude-spam-classification.test.ts`.
- **The message frame is decided on the string.** A message is shown in a
  sandboxed `srcdoc` iframe, and everything about what it may do is settled
  in the markup before the frame parses it (`prepareFrame`,
  `utils/messageFrame.ts`) -- never in a `load` handler. The frame fires
  `load` only once every image has arrived, and a message is tappable long
  before: measured, a link rewritten in `load` was still untouched 2.5
  seconds into a message with one slow picture, and tapping it navigated the
  frame into the page's own `frame-src 'self'` and a grey "This content is
  blocked". That cost two deploys. Links, remote content (spam folder) and
  everything else happen on **one parse of the whole frame document**, so
  the parser merges a message's `<body>` attributes as the frame's will; the
  result is then checked by parsing it *again*, the way the frame will,
  because two readings of HTML can disagree. What the two readings cannot
  see alike is taken out rather than chased: nested documents (`<iframe
  srcdoc>` inherits the sandbox, popups-escape included), declarative shadow
  roots (the frame's parser attaches `shadowrootmode`, DOMParser does not)
  and SMIL animations of `href`/`target`. Each of those was measured letting
  a link or a spam-folder pixel through. Destinations are read from the
  attribute (`href` or `xlink:href`), never from `.href`, which is not a
  string on SVG and does not exist on MathML. Every link either opens a new
  tab or has its destination taken away: `mailto:` and `about:blank` in the
  frame were measured taking the message away, and so were `href="#"`, `""`
  and `#section` -- a `srcdoc` document resolves those against the page, not
  itself, and no in-message jump is possible without scripts. Addresses are
  read as the URL parser reads them (`trim` strips more). Every rule is one
  `FrameRule` (`utils/frameRules.ts`): the rewrite mends what `find` returns
  and the check asks it to return nothing, so the two cannot drift. In the
  spam folder, CSS is matched after its escapes are decoded (`u\rl(` fetched
  otherwise) and SVG attributes that take `url()` are read as CSS. A policy of
  the frame's own does not help: a `<meta>` CSP in the `srcdoc` and the
  iframe's `csp` attribute were both measured holding nothing back.
  The frame is this page's origin (`allow-same-origin`: the inline pictures
  reach the API with the reader's session), which has two consequences, both
  measured. Its requests name this page -- the open message's address, with
  the mailbox in it -- as their referrer, so a message's own
  `referrerpolicy` and `<meta name="referrer">` are taken out and the page's
  `same-origin` holds. And Chromium applies a `<meta name="referrer">` that
  **DOMParser** finds to the page that parsed it, for the life of the page:
  one message changed the policy for every request after it, spam folder
  included. `referrerGuard.ts` wraps DOMParser at start-up so every parse --
  ours and the editor's -- puts the page's policy back. Second, a path here
  named by a message is fetched with the reader's cookie, so the Worker
  answers a request the browser marks as a picture, stylesheet or other
  subresource (`Sec-Fetch-Dest`) only for an attachment (`loadableAs`).
  That header does not cover everything: `<link rel=prefetch>` goes out as
  `empty`, like the dashboard's own calls, and `<a ping>` as a POST when the
  link is tapped. Measured in the inbox, the first read the whole export and
  the second signed the reader out. So the cookie signs in only a GET of an
  attachment, `/docs` and `/openapi.json` (`sessionTokenOf`,
  `routes/auth.ts`) -- what cannot carry the bearer token -- and every other
  route needs the header, which a message has no way to add. The frame takes
  out every `<link>` but a stylesheet, and `ping` and `attributionsrc`, in
  every folder (`REQUESTS_NOBODY_ASKED_FOR`). `cookie-scope.test.ts`.
- **The reply editor is this page, not the frame.** A reply or forward puts
  the original into tiptap, outside the sandbox, so what the editor's schema
  lets through of a message is this page's markup. Tiptap's highlight wrote
  `<mark data-color>` into `style` whole: measured in Chromium, a value with a
  `;` in it laid a `position: fixed` layer over the dashboard and fetched a
  picture from the sender the moment the reply opened, and would have gone
  out in the reply too. Both colour marks take a colour and nothing else, on
  the way in and on the way out (`utils/editorColours.ts`,
  `editorColours.test.ts`). A new extension that copies an attribute into
  `style` needs the same.
  A quoted picture is shown there by its address here (`cid:` loads nothing
  on this page), so on the way out every `<img>` naming an attachment of
  this deployment goes back to a `cid:` with the picture attached under it
  (`outgoingPictures`, `utils/inlineImages.ts`): left as it was, it named
  the mailbox to the recipient and opened nothing for them. It is found in
  the HTML at send time, not remembered, so a resumed draft sends its
  pictures and a deleted one is not sent. `composeQuotedPictures.test.ts`.
- **Dashboard theming.** `index.html` carries the only page background and it
  has both halves (`bg-gray-100 text-gray-900 dark:bg-gray-900
  dark:text-gray-100`); cards use `bg-white dark:bg-gray-800` and follow the
  viewer. It used to pin the body dark unconditionally, which made every
  card's text near-white on white in light mode — that is fixed, and
  `formContrast.test.ts` keeps its rule (a field says its own text colour)
  for its own sake rather than because of the body.
  Measured since, in Chromium, over thirteen screens in both schemes (194
  text nodes each): everything clears WCAG AA. Two did not, and neither was
  a light/dark slip. `text-white` on `bg-green-600` was 3.22:1 — Tailwind 4's
  palette is lighter than the hex era these buttons were written in, so a
  shade that used to pass no longer does. And `text-gray-500` reads 4.84 on a
  white card but 4.39 on the page itself, which is gray-100: the same class
  passes or fails by what is behind it. `whiteOnColour.test.ts` holds the
  first from the source, carrying the measured ratios and refusing a colour
  nobody has measured.
- **Narrow screens.** The dashboard is measured at 320 CSS pixels, which is
  WCAG 2.2 SC 1.4.10's own figure and also a phone. Eleven findings the first
  time: every signed-in screen scrolled sideways by 16px, `/account` and
  `/admin` by 52, `/root` by 9, and 4px of the email card was cut off by a box
  that hides its overflow. All of them were a row that would not shrink -- a
  `flex-shrink-0` on the group at the end of a header, or a `w-72` field in a
  content-width wrapper. Worse, and invisible to an audit that only looks for
  sideways scrolling: the header's search box was squeezed to nothing. The row
  fitted, so nothing complained; the field was simply the only thing that
  could give. The header wraps below `sm` now and the search box takes the
  second line. When you change a row that holds a heading and some controls,
  measure the *controls*, not only the page: a zero-width one loses
  functionality without moving the page a pixel. `reflow320.test.ts` carries
  the measurements and holds the places that were told they may shrink.

- **One tab, two people.** Ending a session empties what was on screen
  (`forgetThisPerson` in the auth store) and moves `sessionGeneration` on;
  api.ts leaves an answer to a request sent under an ended session
  unsettled, because the stores it would write into are the next person's --
  a late mailbox list showed them the last one's, and a late 401 ended their
  session. A message being written stays on screen when the session ends
  (to be copied) and goes when the next one starts. A sign-out the server did
  not hear is tried again and, failing that, sent the next time the
  dashboard opens (`signOutPending`). `sessionHandover.test.ts`.
- **Screens inside the mailbox frame are keyed by path.** They read their
  message, folder or mailbox when first shown, and the router reuses a screen
  when only the path's ids change: a notification for another message left
  the open one showing, and a reply went to it. `Mailbox.vue`'s router-view
  keys by `path` (not query, so typing a search is not a new screen);
  `mailboxSwitch.test.ts`.

## Working here

```bash
pnpm install
pnpm lint     # biome; it autofixes, then fails if it had to
pnpm test     # both suites -- what CI runs
pnpm build    # the dashboard (includes vue-tsc), copied into the worker's assets
```

To try a change against a real runtime, build first, then run the deployment
worker locally:

```bash
pnpm build
cd packages/worker/dev && npx wrangler dev
```

Check which bundle is actually being served before concluding anything from a
browser session -- `curl -s localhost:8787/ | grep -o 'index-[A-Za-z0-9_-]*\.js'`
against the file the build just produced. A stale bundle makes a verification
run agree with whatever you expected, whichever way you expected it.

The Cloudflare token is given only to the steps that run wrangler, not to
the job, and the actions are pinned to commits; `workflowGuards.test.ts`
holds both. The check below waits up to about a minute for the new build to
be served: twelve seconds once was not enough, and a run failed on a deploy
that was fine.

The deploy workflow now asks production the same question, in its last step:
the entry script's name in the served page, that file's bytes by hash, the
SPA fallback on a deep path, and an API path answered by the Worker rather
than by the page being served in its place. So "the bundle I measured is the
bundle that is live" is something the log says rather than something to
assume. And the Worker is asked which version it is (`version` in
`/api/v1/settings`, from the `version_metadata` binding) and compared with the
one `wrangler deployments status` said is live: a change to the Worker alone
leaves the page and its bundle as they were, so they prove nothing about the
code. It asks the address `wrangler deploy` printed, which the deploy step
keeps whole in `$RUNNER_TEMP/deploy-output.txt` -- a file, never the log,
which strikes every address out -- so nothing has to be set for it to run
(`deployedAddress`). It used to need a `PRODUCTION_URL` secret, and without
one the step was skipped, and the rollback below with it, since only this
step's failure sets it off; deleting the secret turned both off. The secret
is now only for a Worker wrangler reports no address for, and to mask a
domain of its own; the check masks the host it asks either way. With
neither, it warns rather than passing in silence. The step before it prints the version that is actually running,
which on a deploy that gave the Worker its push key is *not* the id the deploy
step prints -- putting a secret publishes a version of its own, after it.

A deploy that fails once it is live is rolled back. The step before the
deploy notes the version that is live then (`steps.before`), and the last
step, on `failure()`, puts it back with `wrangler rollback` unless it is still
the one live, and checks that it is. The run stays red, so the failure is
still mailed; production just does not stay on it.

The checks are four jobs side by side -- lint and build, the worker suite,
the dashboard suite, the advisory check -- and the deploy needs all four. The
worker suite does not need the build.

The advisory check (`advisories`, `scripts/check-advisories.mjs`) asks
GitHub's own advisory database -- the one Dependabot mails from -- about
every package `pnpm-lock.yaml` pins, and fails on high, critical or malware.
`pnpm audit` reads npm's copy, which lagged: Dependabot mailed an advisory
for sharp while the pre-merge check still said "No known vulnerabilities".
A check that asks a service passes on silence, so each run first asks about
two releases with long-standing critical advisories, among as many of the
lockfile's longest names as a real question holds -- the same shape and at
least the same length -- and stops unless both come back
(`controlQuestion`, `controlProblem`); a request that fails fails the check
too. Its first run asked about 584 packages and was told of none. It uses
the token Actions gives every job, read-only here, so a fork sets up
nothing, and it installs nothing, so no install script runs beside that
token. The judgement is `advisories.mjs`, tested in the worker pool
(`advisories.test.ts`); `workflowGuards.test.ts` holds the job's shape. An
advisory with no fixed release yet stops every merge and deploy until it is
dealt with -- that is the point, and the decision is the owner's.

Every evening at 18:30 UTC, half an hour after the Worker's cron,
`night-check.yml` reads `maintenance/last-run.json` and `backup-carry/`
through the R2 API and fails when the night did not end well
(`scripts/night-check.mjs`, `night-check.test.ts`): no run in 24 hours, a run
cut off, a pass that failed or recorded nothing, a deletion left unfinished,
a night still carrying on after twenty minutes more, or a paused backup
nothing carries on. A failed scheduled run is mailed to the owner, so nobody
has to open `/root` to find out -- the nights of 09-04 and 09-22 were found
days later, by hand. It prints counts and times, never a mailbox. It also
fails at fifty days without a commit, because GitHub turns a schedule off at
sixty and that is the one failure it could not report. `workflowGuards.test.ts`
holds the rollback, the `needs`, the thirty minutes and the night check's
token.

A test that hands the nightly code a fixed date is a time bomb wherever that
code compares the date with the real clock: `backup-slices.test.ts` was
fixed at 2026-10-02 and began failing twenty hours later, when the night it
named had become one too old to carry on (`NIGHT_LONGEST_MS`).

Production URLs and the mail domain are secrets rather than repository
variables, and not out of squeamishness: this repository is public, its
Actions logs are public, and the runner prints every step's environment and
rendered script. A secret's value is replaced with `***` in all of that; a
variable is published on every run. The first run of the Email Routing
workflow published the mail domain exactly that way, through an input that
looked careful because it kept the domain out of the file. (That workflow is
gone: in two runs every query it existed for was refused for want of token
permissions the deploy does not need, and the Cloudflare dashboard shows the
same settings without widening the deploy's token.)

And it is not only what a step is *given* that gets published -- it is what
the tools it runs decide to print. `wrangler deployments status` names the
account that published a version, so adding that step put a personal address
into a public log on its first run. And a refused token makes wrangler print
the owner's address from whichever step meets it first. So every step that
runs wrangler pipes it through `scripts/withhold.mjs`, under `pipefail`,
which strikes out anything shaped like an email or a `workers.dev` host
(`log-redaction.mjs`); `workflowGuards.test.ts` holds that none is left out.
An account *name* of the owner's own choosing has no shape to match. Before
adding a step that prints a tool's output, read one run of it.

Reply and forward call the real Resend API. Without outbound network that
request returns 500 no matter what is in it; the tests stub `api.resend.com`
through the pool's `outboundService`. Check the request the page sent rather
than the response when verifying compose behaviour offline.

`pnpm test` and `pnpm build` disagree about what a dashboard test may import.
Vitest runs tests in node, but `type-check` compiles all of `src/**/*` --
tests included -- against `@vue/tsconfig`'s DOM config, which has no node
types. So a test under `src/` that imports `node:fs` passes `pnpm test` and
fails `pnpm build` with TS2307. Read fixtures with `import.meta.glob` instead
(`messages.test.ts` and `readmeDocs.test.ts` both do); it reaches outside the
package fine. Run `pnpm build` before pushing a new test, and take the exit
code directly -- piping it through `tail` reports the pager's status, not the
compiler's.

### Worker tests

`@cloudflare/vitest-pool-workers` dropped `isolatedStorage` in 0.22, so
`tests/reset-storage.ts` calls `reset()` after every test through
`setupFiles`. That wipes storage completely rather than unwinding one test's
writes, so state set up in `beforeAll` does not survive into the tests that
follow it. Set up per test with `beforeEach`.

The tests are type-checked before they run (`tests/tsconfig.json`, and
`tests/tsconfig.node.json` for the config file, which runs in node). The pool
types `env` as `Cloudflare.Env` since 0.22; `tests/bindings.d.ts` fills that
in. Before it did, `env` was untyped, 182 errors went unreported, and a
`@ts-expect-error` sat on nearly every binding -- and `singleWorker: true`,
an option 0.22 no longer has, went on being passed and ignored.

A test has fifteen seconds, not vitest's five (`testTimeout` in
`tests/vitest.config.mts`). Measured over the whole suite on a quiet machine,
24 tests took over 1.5s and one took 4.6s with no budget of its own -- 35
sign-ins, each a real PBKDF2 at 100,000 iterations. The time is the work, CI
is slower by a factor nobody controls, and a per-test budget forgotten took a
deploy down twice. The per-test budgets that were already there stay, each
with the waiting it accounts for.

### Dashboard tests

A test that mounts a screen loads the real English catalogue under its own
strings (`englishWith`, `src/testing/english.ts`) and navigates before the
router is installed. Without the first, every key the screen asks for and the
test did not name printed a warning; without the second, the router resolved
the memory history's empty start and warned. Over a hundred such lines a run
buried the two that were real: a catalogue key the compile check never
reached, and a second copy of the editor's Link extension.

## Security checks

Every change goes to main through a pull request, and is merged only after
all of these pass, in this order:

1. Both test suites (CI runs them on the pull request). The permission
   boundaries are tested from both sides: `route-access.test.ts` asks every
   route as somebody who must be refused *and* as somebody who must be let
   in, and `root-accounts.test.ts` holds that a deleted person's open session
   reaches nothing.
2. `.claude/pre-merge-check.sh`: `pnpm audit --audit-level high` (pnpm's own
   audit; the workspace is pnpm), then Gitleaks twice: over the commits being
   merged, and over the whole of HEAD's history (a shallow clone is fetched in
   full first). A high or critical advisory, or a key, stops the merge, and a
   key is printed as its rule, file, line and commit -- never its value, and
   never its author, which gitleaks' own `-v` prints. The file is printed as a
   JSON string in printable ASCII, since a pull request names it: printed as
   it came, a newline and an escape in a name wrote "no leaks found" as a line
   of the check's own. A key found is taken out of the code at once; history
   is not rewritten, and the key is reported as exposed, by name, file and
   commit, never by value.
   `pnpm audit` here is the second reading of the advisories, not the
   first: CI's `advisories` job asks GitHub's database, which `pnpm audit`
   has been seen to trail (see "Working here").
   A key in the commits being merged cannot be registered away. A key in
   history already on main is reported the same way, and whether the full
   scan then lets it through is the owner's decision: its fingerprint, by
   commit, goes in `.claude/gitleaks-known-history` under a line saying why,
   and that pull request's description gives the rule, file, line and commit.
   Only the full scan reads that file, and a line naming a commit not yet on
   the base stops the check. The scan of the commits being merged has to read
   all of them, merges included, for that to hold: gitleaks matches a
   registered line against a finding's commit, file, rule and line, and also
   against a file *named* `<commit>:<path>` -- git allows a colon in a path --
   so while that scan skipped merges, a merge adding a file by that name
   passed both. The two lines there now are upstream's
   `ROADMAP.md`, imported whole in 9cb6794 and taken out in eaa26ed;
   upstream's main still has it, so the values are upstream's, and nobody
   here has examined them.
   These were each measured letting a pull request's own key through, and
   are refused or overridden. A `.gitleaksignore` at the root (gitleaks reads
   it whatever `-i` names): a fork that keeps one can move its fingerprints of
   main's history, by commit, into that file, and nothing else of it. A
   `.gitleaks.toml` there or a config in gitleaks' environment (read when no
   `--config` is given): its rules and allowlists have nowhere to go, since
   the check runs gitleaks' default config alone. A `gitleaks:allow` on the
   line. Whatever makes git print "Binary files differ" -- a `.gitattributes`
   that marks the file binary, or one NUL byte in it. And anything git writes
   to stderr: gitleaks stops reading at the first such line and reports what
   it had read as a pass, so a `.gitattributes` line git warns about passed a
   key with nothing scanned, as did a partial clone whose remote was out of
   reach. Each scan therefore runs the same `git log` first and stops on any
   word from it, shown through `cat -v`, because git quotes a pull request's
   own bytes back in it. The runner's own git config blinded both scans too,
   and both read with flags that override it: `--no-color`
   (`color.ui=always`); `--root` (`log.showRoot=false` hid a root commit's
   diff, and a pull request can merge in a history whose root adds a key the
   next commit takes out); and `--diff-merges=separate` rather than `-m`,
   which follows `log.diffMerges` and, set to `combined`, read nothing of a
   merge. Without merge diffs a key that only a merge put in -- a conflict's
   resolution, or a file the merge added itself -- was never read; the cost
   is that a registered key a merge carries comes up again under the merge's
   commit, and needs a line of its own.
   That is not every way. Neither scan reads a commit's message, a tag or a
   note, nor anything the `[allowlist]` of the pinned v8.30.1 default config
   allows whatever it is given (`config/gitleaks.toml` in the module the
   script installs, under `go env GOMODCACHE`), and a pull request can use
   any of it. By path: lock files, images, fonts, documents and binaries
   (`.pdf`, `.docx`, `.xlsx`, `.bin`, `.exe` and more), `go.mod` and
   `go.sum`, `node_modules`, `bower_components`, `vendor/github.com/...`, a
   `.js` whose name starts with angular, bootstrap, jquery, plotly or
   swagger-ui, Python's `env/lib` and `*.dist-info`, and any path with
   `gitleaks.toml` in it. By value: one that starts with `true`, has `false`
   in it or ends with `null`, one letter repeated, and placeholder shapes
   such as `${NAME}`. And lines particular rules accept. Measured, a key
   passed both scans in `pnpm-lock.yaml`, an SVG, a `.pdf` holding text,
   `go.mod`, `src/bootstrap.js`, `src/jquery-helpers.js`, and under
   `node_modules`, `bower_components`, `vendor/github.com/`, `env/lib` and a
   `.dist-info`; in a `gitleaks.toml.bak`; with `false` in its value; on a
   line `generic-api-key` accepts (`--mount=type=secret,`); and in a commit's
   message. Nor can a pattern find a key cut into pieces, or encoded in a way
   gitleaks does not decode (it decodes base64, hex, percent and unicode
   escapes). Those are for review to catch.
   `preMergeKeys.test.ts` holds the script to all of this.
3. `/security-review` in a session other than the one that made the change
   (`REPLY_RULES=off claude -p "/security-review"` on the branch is one; see
   "Replies to the owner"). A finding judged a false positive is explained in
   the pull request's description.
4. For a change to a boundary, authentication or key handling, Claude
   Security over that change (`/claude-security`, "scan changes").

`.claude/settings.json` turns on two plugins from Anthropic's official
marketplace: `security-guidance`, which checks code as it is written against
`.claude/claude-security-guidance.md` (this project's boundaries and key
rules) and `.claude/security-patterns.json` (a key of this project's kinds
written out, or a key-like name given a value in a Wrangler config), and
`claude-security`. Its reports (`CLAUDE-SECURITY-<time>/`) are never
committed. Dependabot and testing the live deployment from outside are not
part of this.

## Replies to the owner

CLAUDE.md sets how an agent writes to the owner: in Japanese, items numbered
once each and never bulleted at the margin, no numbered headings. Written down
only, those rules were broken in the session that wrote them -- the rule is
read at the start, and kept or not at every line after. So
`.claude/settings.json` also registers `.claude/hooks/reply-rules.mjs` on
three events: `UserPromptSubmit` puts the rules beside every prompt;
`PostToolBatch` reads the text written in the same model message as the tools
and says so when it broke one; `Stop` sends a final reply that breaks one back
to be rewritten, at most twice, as feedback rather than a block (a block is
shown to the owner as a hook error).

What counts as "the reply" is read off the transcript by the chain of parents
from the prompt that started it, and by nothing else. The same file holds rows
the owner never reads, and none of them can be told apart by model or label:
the security-guidance plugin's review runs as an SDK session on the same
model, and a `claude -p` started from the session shares its id and its file.
A version sent back is not counted either: counted, its numbers clashed with
the rewrite's, and a faithful rewrite was sent back again. A line counts as
English by its words in lower case, because names are capitalised and a
Japanese line naming three of them is still Japanese; inline code, paths,
links, quotes and asides in parentheses are not read at all.

`REPLY_RULES=off` in the environment turns it off, for a run nobody reads as a
reply (the pre-merge `/security-review` below, whose format is its own) and for
a fork that wants none of this. The hook exits quietly on anything it cannot
read, its own judge included, so it never stops the work. The rules and the
whole of what the hook decides are in `reply-rules-judge.mjs`, pure so the
worker suite tests them (`reply-rules.test.ts`): each rule from both sides, and
each seen to fail with its rule taken out. A fork that wants other rules
changes CLAUDE.md, the judge and its test together.

## Conventions

- Every push to `main` deploys. One workflow does it (`deploy.yml`), and it
  runs lint, build, both test suites and the advisory check first.
- Comments explain why, not what. A sentence about the constraint that forced
  the code beats a restatement of the code.
- A message shown to the user is never stored as an already-translated string.
  `t("...")` returns a plain string, so `message.value = t("...")` freezes it
  at whichever of the 73 languages was current: the line stays behind when the
  language changes while every `t(...)` in the template follows. Store how to
  produce it — `useLocalizedMessage` for a message set by an action,
  `computed` for one derived from state. `storedMessages.test.ts` fails on the
  old shape; a line built inside a `watch` slips past it, so check by hand.
  A toast is the same: hand it `() => t("...")`, not `t("...")`
  (`ToastMessage`); the same test holds it.
- Keep business identifiers out of `packages/worker/src`,
  `packages/dashboard` and the tests — this repository is public.
  Deployment-specific values belong in `packages/worker/dev`.
