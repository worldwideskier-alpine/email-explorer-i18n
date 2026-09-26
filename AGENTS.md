# Agents

Orientation for anyone — human or agent — working in this repository.

## What this is

A multilingual (Japanese / English / German) fork of
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

`ACCOUNT_RECOVERY_FROM` is the one that also exists as an
`EmailExplorer({ accountRecovery })` option, and **the variable wins**. Source
code is what a fork inherits; the variable is what the fork itself sets. See
`src/deployment-config.ts`.

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
  src/locales/         ja / en / de message catalogues
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
- **The auth gate.** `fetch()` validates the session before Hono routes
  anything. `PUBLIC_ROUTES` is the exact-match allowlist of what may be
  reached without one — exact, because a prefix match silently makes every
  future path starting with a public one public too. Static assets never
  reach the Worker at all: `run_worker_first` in wrangler.jsonc sends only
  `/api/*`, `/docs` and `/openapi.json` here.
- **API schema.** Generated at runtime by chanfana from the route classes.
  There is no checked-in `openapi.json`, and `/openapi.json` needs a session.
- **Sending.** Outbound mail goes through Resend, not Email Routing.
- **Roles.** `root` / `admin` / `member`, decided in `roles.ts`. Root is an
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
- **A shared R2 object is rewritten conditionally.** A mailbox's settings
  object has four writers -- a save, a spam verdict, the nightly backup and
  purge -- and each put back the whole object it had read, so two at once
  left only the second. `rewriteJson` (`r2-json.ts`) puts only if the object
  is still the one read (its etag) and otherwise makes the change again on
  what the other writer left. R2 does have that; an earlier note here said it
  did not. Settings saves also merge onto what is stored, so a save carries
  only the section it changes.
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
  first. `throttleTake` checks and counts in one call, and a success hands
  back what it should not have cost through `throttleSettle` -- per rule:
  the account's key resets, the IP's key (shared by every account behind it)
  gets back only that attempt. `auth-concurrency.test.ts` holds both.
  Creating a mailbox is the same shape: the address is claimed in one call
  to the auth object (`claimMailboxForPersonOf`) before anything is written,
  because two people creating the same new address at once both got it.
- **Adding or removing a sign-in address asks for the password.** It outlasts
  the session it is done from: with a session alone, a thief added a login of
  their own to the owner's person, which a reset of the owner's password does
  not touch. The same holds for root's spare (`PostAccount` with `role:
  "root"`), which is the role for good. `proveCurrentPassword` in
  `routes/auth.ts`, under the account-change limit; `own-logins.test.ts`.
- **Ending a session ends its push subscription.** A notification carries
  the sender and subject of each new message, so a subscription is bound to
  the session that registered it and delivered to only while that session
  lives; a password change, a reset and root setting a password end the
  others with their sessions. The dashboard hands the browser's subscription
  to each new session (`rebindPushSubscription`), since the browser keeps it
  and the settings switch reads it from there. `sessions-end.test.ts`.
- **Threading uses the sender's Message-ID.** Ingest keeps it in
  `message_id`; a reply names it in In-Reply-To and References, and never a
  row id, which no other client has seen (`replyThreading`,
  `routes/reply-forward.ts`). Mail sent from here has none we know -- Resend
  assigns it and does not say -- so a reply to it carries no In-Reply-To and
  keeps the thread through References.
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
- **The daily cron.** One `scheduled()` handler, and the order inside it
  matters: `scheduled-run.ts` backs every mailbox up *first* and deletes old
  spam *second*, so a message the purge removes is already in that run's
  archive. Reversed, the deletion would be permanent with no copy anywhere.
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
  Three things came out of it, all of which a rewrite could quietly undo:
  `backup-writer.ts` reads messages a page at a time (one Durable Object round
  trip per message was over 1500 per invocation, plus one R2 read each);
  `backup-run.ts` takes the **most overdue mailbox first**, so a mailbox missed
  tonight is first tomorrow rather than never; and the pass reports progress as
  it goes into `MaintenanceRecord.backupProgress`, which is the only thing a
  killed run leaves behind. `backup-pass-progress.test.ts` holds all three.
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
- **Dashboard theming.** `index.html` carries the only page background and it
  has both halves (`bg-gray-100 text-gray-900 dark:bg-gray-900
  dark:text-gray-100`); cards use `bg-white dark:bg-gray-800` and follow the
  viewer. It used to pin the body dark unconditionally, which made every
  card's text near-white on white in light mode — that is fixed, and the
  docblocks in `formContrast.test.ts` still describe the old state.
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

## Working here

```bash
pnpm install
pnpm lint     # biome; it autofixes, then fails if it had to
pnpm test     # both suites -- what CI runs
pnpm build    # dashboard, then worker (includes vue-tsc)
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

The deploy workflow now asks production the same question, in its last step:
the entry script's name in the served page, that file's bytes by hash, the
SPA fallback on a deep path, and an API path answered by the Worker rather
than by the page being served in its place. So "the bundle I measured is the
bundle that is live" is something the log says rather than something to
assume. It needs the `PRODUCTION_URL` secret; without it the step is skipped
and says so. The step before it prints the version that is actually running,
which is *not* the id the deploy step prints -- uploading the VAPID secret
publishes a version of its own, after it.

Production URLs and the mail domain are secrets rather than repository
variables, and not out of squeamishness: this repository is public, its
Actions logs are public, and the runner prints every step's environment and
rendered script. A secret's value is replaced with `***` in all of that; a
variable is published on every run. The first run of the Email Routing
workflow published the mail domain exactly that way, through an input that
looked careful because it kept the domain out of the file.

And it is not only what a step is *given* that gets published -- it is what
the tools it runs decide to print. `wrangler deployments status` names the
account that published a version, so adding that step put a personal address
into a public log on its first run; its output is now filtered by the shape of
an address rather than by any particular value. Before adding a step that
prints a tool's output, read one run of it.

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

## Conventions

- Every push to `main` deploys. One workflow does it (`deploy.yml`), and it
  runs lint, build and both test suites first.
- Comments explain why, not what. A sentence about the constraint that forced
  the code beats a restatement of the code.
- A message shown to the user is never stored as an already-translated string.
  `t("...")` returns a plain string, so `message.value = t("...")` freezes it
  at whichever of the 69 languages was current: the line stays behind when the
  language changes while every `t(...)` in the template follows. Store how to
  produce it — `useLocalizedMessage` for a message set by an action,
  `computed` for one derived from state. `storedMessages.test.ts` fails on the
  old shape; a line built inside a `watch` slips past it, so check by hand.
- Keep business identifiers out of `packages/worker/src`,
  `packages/dashboard` and the tests — this repository is public.
  Deployment-specific values belong in `packages/worker/dev`.
