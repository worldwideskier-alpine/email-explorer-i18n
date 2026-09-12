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
  `/api/v1/root/*` route refuses everyone; while there is none, an
  **the first account to register is root**, and that is the only way one
  comes into being -- `claimRoot` is called from registration and is reachable
  from no route. An endpoint that named a root, however well guarded, would
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
  through the screen.
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
- **The daily cron.** One `scheduled()` handler, and the order inside it
  matters: `scheduled-run.ts` backs every mailbox up *first* and deletes old
  spam *second*, so a message the purge removes is already in that run's
  archive. Reversed, the deletion would be permanent with no copy anywhere.
  Nothing in the types holds it; `scheduled-order.test.ts` does.
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
