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
- **The daily cron.** One `scheduled()` handler, and the order inside it
  matters: `scheduled-run.ts` backs every mailbox up *first* and deletes old
  spam *second*, so a message the purge removes is already in that run's
  archive. Reversed, the deletion would be permanent with no copy anywhere.
  Nothing in the types holds it; `scheduled-order.test.ts` does.
- **Dashboard theming.** `index.html` fixes the body to a dark palette
  (`bg-gray-900 text-gray-100`) while cards use `bg-white dark:bg-gray-800`
  and follow the viewer's colour scheme. In light mode a card is white but
  text still inherits gray-100, so anything without its own unprefixed text
  colour renders near-white on white. `formContrast.test.ts` enforces that
  for form controls; the wider inconsistency is still there.

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
