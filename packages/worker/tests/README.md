# Worker tests

Vitest on `@cloudflare/vitest-pool-workers`, so the tests run inside workerd
with the Durable Objects and the R2 bucket of `dev/wrangler.jsonc` -- the same
configuration the deployment uses, not a copy of it.

```bash
pnpm --filter email-explorer test                 # type-check, then every test
cd packages/worker && npx vitest run --config tests/vitest.config.mts tests/integration/auth.test.ts
```

`test` runs `tsc` over the source, the tests (`tests/tsconfig.json`) and the
config (`tests/tsconfig.node.json`) before vitest, so a test that does not
type-check fails the run. CI runs this through `pnpm test` at the root, in
`.github/workflows/deploy.yml`, before anything is deployed.

## Layout

- `unit/` -- pure functions: address parsing, spam prompts, mbox, the
  nightly limits' arithmetic, and so on.
- `integration/` -- the Worker as a whole, through `SELF.fetch` or its
  `email()` and `scheduled()` entry points, one file per behaviour.
  `route-access.test.ts` holds the table of every route and who may reach it;
  a new route fails it until it is put there.

## What the setup gives you

- **Storage is wiped after every test** (`tests/reset-storage.ts`, through
  `setupFiles`). The pool dropped `isolatedStorage` in 0.22, so state made in
  `beforeAll` does not survive into the tests after it: set up in
  `beforeEach`.
- **A signed-in person** from `testAuthBeforeAll()` in `integration/utils.ts`:
  a session whose token is `sessionToken`, sent by `authenticatedFetch()` as a
  Bearer token, and a sending key (`giveSendingKey`) as a real person would
  have set.
- **A mailbox** held by that person, from `createDummyMailbox()` (through the
  API) or `createMailbox()` (straight into the bucket, with its grant).
- **Resend is stubbed** through the pool's `outboundService`: nothing leaves
  the machine, and a test reads the request the Worker sent.

## Things that will bite

- An error thrown by a Durable Object through a route leaves the pool hanging
  rather than failing the test. When a Durable Object method is what is being
  tested, call it on the instance with `runInDurableObject`, which fails
  properly (`many-attachments.test.ts` does both).
- An RPC stub cannot be wrapped in a `Proxy`: every property of it is a
  remote call, `bind` included. To give a route a mailbox that misbehaves,
  hand it a plain object with just the methods the route calls
  (`draft-save-gone.test.ts`, `nightly-limits.test.ts`).
- Time inside workerd moves only across I/O. A test about a deadline moves
  `Date.now` itself rather than waiting (`nightly-limits.test.ts`).
- The first account registered becomes root. A test about an administrator
  registers someone first or seeds the auth object directly.
