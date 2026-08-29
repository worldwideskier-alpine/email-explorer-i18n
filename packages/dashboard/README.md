# email-explorer-dashboard

The Vue 3 single-page app that Email Explorer serves. It is not deployed on
its own: `pnpm build` at the repository root builds it, and the worker's build
step copies `dist/` into `packages/worker/dashboard`, which the Worker then
serves as static assets.

## Layout

```
src/views/         One component per route (mailbox, email detail, settings, login, ...)
src/components/    Shared pieces -- the composer, the rich-text editor, dialogs
src/stores/        Pinia stores; emails.ts holds the list/pagination logic
src/services/      api.ts, the single axios client (bearer token + session cookie)
src/utils/         Logic with no UI, unit tested -- e.g. htmlToPlainText.ts
src/locales/       ja / en / de message catalogues; every string lives here
public/            PWA manifest, icons and the service worker
```

## Commands

Run these from the repository root unless you are only touching the dashboard.

```sh
pnpm test-dashboard   # vitest on jsdom
pnpm build-dashboard  # vue-tsc, then vite build
```

Inside this package, `pnpm dev` starts Vite on its own for quick UI work.
It has no backend, so anything that calls the API will fail; to exercise the
real thing, build and run the Worker (see the repository root's AGENTS.md).

## Adding a string

Never write user-visible text inline. Add the key to all three files in
`src/locales/` and use `t("...")`. The build does not check for missing keys,
so a key added to only `ja.json` will silently fall back to the key name for
English and German readers.
