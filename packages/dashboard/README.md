# email-explorer-dashboard

The Vue 3 single-page app that Email Explorer serves. It is not deployed on
its own: `pnpm build` at the repository root builds it, and the worker's build
step copies `dist/` into `packages/worker/dashboard`, which the Worker then
serves as static assets.

## Layout

```
src/views/         One component per route (mailbox, email detail, settings, login, ...)
src/components/    Shared pieces -- the composer, the rich-text editor, the switch and secret-input controls
src/stores/        Pinia stores; emails.ts holds the list/pagination logic
src/services/      api.ts, the single axios client (the session goes as a bearer token)
src/utils/         Logic with no UI, unit tested -- e.g. htmlToPlainText.ts
src/locales/       the 73 message catalogues (registry.ts names them); every string lives here
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

Never write user-visible text inline. Add the key to every one of the 73
catalogues in `src/locales/` and use `t("...")`. The build does not check for
missing keys, but `messages.test.ts` does: it fails unless every catalogue has
exactly the keys of `en.json`, and it compiles every message, so a bare `@` or
`|` in a value (which vue-i18n reads as syntax) fails there rather than on
screen.
