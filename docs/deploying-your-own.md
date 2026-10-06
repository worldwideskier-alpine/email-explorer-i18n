# Deploying your own

This repository is meant to be **forked and deployed**, not copied file by
file. You fork it, set a handful of values as GitHub repository variables and
secrets, and every push to `main` deploys your own instance to your own
Cloudflare account.

What you configure lives in GitHub's settings, or on your deployment's own
screens, rather than in a tracked file, so syncing later updates from this
repository never collides with it.

## What you need

- A Cloudflare account. The free tier is enough for a personal or small
  business mailbox.
- A domain on that account, with **Email Routing** enabled.
- A [Resend](https://resend.com) account for outbound mail, with that same
  domain verified. Cloudflare Email Routing only receives.

## 1. Fork

Use the **Fork** button. A fork keeps the link to this repository, which is
what lets GitHub's **Sync fork** bring later fixes in (see
[Keeping up to date](#keeping-up-to-date)).

## 2. Create the Cloudflare API token

In the Cloudflare dashboard, **My Profile → API Tokens → Create Token**. The
workflow runs `wrangler deploy`, `wrangler r2 bucket info` / `create`,
`wrangler secret list` / `put`, `wrangler deployments status` and
`wrangler rollback`, and the evening check reads two things from the bucket,
and nothing else, so the token needs, at minimum, **Workers Scripts: Edit**
and **Workers R2 Storage: Edit** on your account. The *Edit Cloudflare
Workers* template includes both, along with permissions this does not use:
nothing here uses KV or Pages.

Note your **Account ID** as well; it is on the right of any zone's overview
page.

**On an account that has never had a Worker**, choose its `workers.dev`
subdomain once before the first deploy: open **Workers & Pages** in the
Cloudflare dashboard and set it there. The Worker is published at
`<worker-name>.<subdomain>.workers.dev`, and wrangler, finding no subdomain,
asks for one interactively -- which it cannot do in a workflow, so the first
deploy fails instead. It is set once per account, not per Worker.

## 3. The push-notification key: nothing to do

A deploy that finds your Worker without a key for signing push notifications
gives it one of its own, and every deploy after that leaves it as it is. For
a new fork that is the first deploy; a fork deployed earlier, and never given
a key, gets one on its next deploy. It is made on the runner and handed
straight to the Worker's secrets (`VAPID_PRIVATE_KEY`): it is not kept on
GitHub, not printed in the log, and neither wrangler nor the Cloudflare
dashboard will show it to anyone afterwards. The Worker works out from it the
public half that browsers need.

If you followed an earlier version of this guide and set a
`VAPID_PRIVATE_KEY` repository secret, delete it (**Settings → Secrets and
variables → Actions**). Nothing reads it any more, and every deploy says so
with a warning until it is gone. Your Worker keeps the key it was given from
it, so notifications carry on.

To replace the key, delete the `VAPID_PRIVATE_KEY` secret from the Worker in
the Cloudflare dashboard (**Workers & Pages →** your Worker **→ Settings →
Variables and Secrets**) and deploy again: the deploy makes a new one. Every
device subscribed under the old key stops receiving notifications until it
subscribes again.

## 4. Set the repository secrets

**Settings → Secrets and variables → Actions → Secrets**:

| Secret | What it is |
|---|---|
| `CLOUDFLARE_API_TOKEN` | From step 2. |
| `CLOUDFLARE_ACCOUNT_ID` | From step 2. |

Two more are optional, and both are addresses rather than credentials. They
are secrets anyway, for one reason: GitHub replaces a secret's value with
`***` wherever it appears in a log, and a public repository's Actions logs
are public. Kept as repository variables they would be printed on every run —
which is what used to happen to the deployed address, in the line wrangler
prints when it finishes.

| Secret | What it is |
|---|---|
| `PRODUCTION_URL` | Where your deployment answers, e.g. `https://your-worker.your-subdomain.workers.dev`. The deploy then asks it what it is serving and fails the run if that is not the build it just made. Without it that check is skipped. The `workers.dev` address is kept out of the log either way; set this as well if you serve the Worker on a domain of your own, which the log would otherwise show. |
| `ACCOUNT_RECOVERY_FROM` | Only if you want the password-reset sender fixed by the deployment rather than set on `/root` (step 7). Set it here rather than as a variable: a variable is printed in the deploy log, in every step's environment and in the bindings wrangler lists. If both exist, this one is used. |

## 5. Set the repository variables

**Settings → Secrets and variables → Actions → Variables**. Each one you
leave out keeps the default checked into `packages/worker/dev/wrangler.jsonc`,
which is this repository's own deployment. **Set the first two**, or you
will deploy under this repository's names; the other two are usually left
unset.

| Variable | What it is |
|---|---|
| `WORKER_NAME` | Your Worker's name. Lowercase letters, digits and dashes. Also decides its `*.workers.dev` address. |
| `R2_BUCKET_NAME` | The R2 bucket holding mail and attachments. Same naming rules. Created for you on the first deploy. |
| `VAPID_PUBLIC_KEY` | Usually left unset. The Worker works out the public half of its push key from the private one (step 3); this is only used for a private key written without its public point, which the deploy never makes. |
| `ACCOUNT_RECOVERY_FROM` | Usually left unset: the password-reset sender is set on `/root` (step 7). Set it only to fix it from the deployment, in which case it wins over `/root` and `/root` says so. Prefer the secret of the same name (step 4), which keeps it out of the public log. |

Nothing in the source names a password-reset sender any more, so a new
deployment starts with "forgot password" off, and it stays off until root
sets a sender on `/root` (or you set the variable above). It used to be a
string in `packages/worker/dev/index.ts`, which every fork inherited: a fork
that set nothing sent its resets as this repository's address, and they
never arrived.

## 6. Deploy

Push to `main`, or run the **Deploy to Cloudflare** workflow by hand from the
Actions tab, on `main`. The run creates the R2 bucket if it is missing, deploys
the Worker, and gives it a push-notification key if it has none (step 3) --
once, on the first deploy that finds it without one; the others say it has
one and leave it.

A new fork has Actions switched off until you enable them in its **Actions**
tab, so the first push deploys nothing until you have.

The deploy log opens with a line per setting saying whether your value or the
default was used — check it the first time.

The Cloudflare token is handed only to the steps that run wrangler, not to
the whole job, and the actions the workflow uses are pinned to commits.

It closes, if you set `PRODUCTION_URL`, by fetching your deployment and
comparing what it serves against what was just built: the entry script's name
in the page, then that file's bytes, then that a deep path still falls back to
the page and that an API path is answered by the Worker rather than by the
page being served in its place. An accepted upload is not a served one, and
the difference is otherwise invisible from here. It waits up to about a
minute for Cloudflare to start serving the new build before calling it wrong.

If that check fails -- or anything else fails once the new version is live --
the run puts back the version that was live before it (`wrangler rollback`)
and stays failed, so you hear about it without your users meeting it.

A second workflow, **Check last night's run**, runs every evening half an hour
after the Worker's nightly cron. It reads what the night left in the bucket --
backups, the spam purge, unfinished deletions -- and fails when it did not end
well, so GitHub mails you instead of you having to open `/root`. It prints
counts and times only. GitHub turns a schedule off after sixty days without
activity in the repository; the check fails ten days before that, and any
commit keeps it on.

## 7. Register, and make the accounts

**Do this as soon as the first deploy has finished.** Until an account
exists, whoever opens the address first and registers becomes root, and
root is not something you can take back afterwards from the site. The
deploy log withholds the `workers.dev` address, but that address is your
Worker's name followed by your account's subdomain, and both can be guessed.

Open your Worker's URL. The **first** account to register becomes root, and
registration closes behind it. Root owns no mailbox: on `/root` it makes
everybody else's accounts, and can add a second address to its own (a spare
way in, not a second root).

Every person sends with their own Resend API key, set on the screen they
manage themselves from: each account root makes signs in, creates its
mailboxes, and pastes its key on `/admin`; root pastes its own on `/root`.
The key is stored in your R2 bucket rather than in a GitHub secret, so
rotating it is not a redeploy. There is no deployment-wide key to fall back
on: a person without one of their own cannot send, and that includes the
mail sent for them -- their password reset and address-change confirmation.
Root's own reset mail therefore needs root's key on `/root`. Give root a
spare address as well (on `/root`, *Kind*: **Owner**): signed in with either,
root can set the other's password on `/root` (**Change password** beside
each address, with root's own current password), no mail involved. The same
button is how root gets an administrator back in who has lost their
password.

Also on `/root`, set the **password reset sender**: the address "forgot
password" and address-change mail is sent from, on a domain verified in
Resend. Until it is set, "forgot password" is off.

## 8. Point your mail at it

In the Cloudflare dashboard, **Email → Email Routing → Routes**, add a custom
address and set its action to **Send to a Worker**, choosing the Worker you
just deployed.

Mail is only accepted for a mailbox that already exists, which is why this
comes after step 7. Anything addressed elsewhere is rejected at the door
rather than filed somewhere nobody watches.

## Keeping up to date

On your fork's page on GitHub, **Sync fork → Update branch** merges this
repository's `main` into yours. That changes your `main`, and a change to
`main` deploys; if no run starts, run **Deploy to Cloudflare** by hand from the
Actions tab. A sync that changes only documentation starts no run on purpose:
the workflow skips pushes that touch nothing but `docs/` (other than
`docs/readme/`), `README.md`, `LICENSE` and `.editorconfig`.

From a clone of your fork, the same thing is:

```bash
git remote add upstream https://github.com/worldwideskier-alpine/email-explorer-i18n.git
git fetch upstream
git merge upstream/main
git push origin main
```

Your configuration is in GitHub's settings, not in the repository, so there is
nothing here to conflict.

## What is optional

- **Push notifications.** Nothing to set up: a deploy gives the Worker its
  key when it has none (step 3). Each person turns notifications on for their
  own browser, in the dashboard's settings. If a deploy could not give the
  Worker a key, it says so with a warning, notifications cannot be turned on
  until it has one, and the next deploy tries again.
- **Outbound mail.** Without a Resend key you can read mail but not send it.
  The app says so rather than failing silently.
- **Second-pass spam filtering.** Per mailbox, on the settings screen, you can
  add an Anthropic API key. Mail that already passed the SPF/DKIM/DMARC check
  is then also read by Claude. With no key that stage is skipped entirely.

## How the configuration reaches the Worker

Worth knowing if something looks wrong.

`packages/worker/dev/wrangler.jsonc` is a real, working configuration — it is
what `wrangler dev` and the test suite read, and it carries this repository's
own values as defaults. At deploy time,
`packages/worker/scripts/apply-deployment-config.mjs` rewrites the four values
above from the environment, in the runner's copy only.

A variable you never created reaches the workflow as an empty string, and
empty means "not set", so the default stands. That is why a fork that
configures nothing still deploys something that runs.
