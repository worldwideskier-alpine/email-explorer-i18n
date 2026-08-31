# Deploying your own

This repository is meant to be **forked and deployed**, not copied file by
file. You fork it, set a handful of values as GitHub repository variables and
secrets, and every push to `main` deploys your own instance to your own
Cloudflare account.

Nothing you configure lives in a tracked file, so pulling later updates from
this repository never collides with your settings.

## What you need

- A Cloudflare account. The free tier is enough for a personal or small
  business mailbox.
- A domain on that account, with **Email Routing** enabled.
- A [Resend](https://resend.com) account for outbound mail, with that same
  domain verified. Cloudflare Email Routing only receives.

## 1. Fork

Use the **Fork** button. A fork keeps the link to this repository, so
`git pull` brings later fixes in.

## 2. Create the Cloudflare API token

In the Cloudflare dashboard, **My Profile → API Tokens → Create Token**, using
the *Edit Cloudflare Workers* template. It needs, at minimum, Workers Scripts
Edit, Workers R2 Storage Edit and Workers KV Storage Edit on your account.

Note your **Account ID** as well; it is on the right of any zone's overview
page.

## 3. Generate a push-notification key pair

```bash
npx @pushforge/builder vapid
```

Keep both halves. The public one is a repository variable, the private one a
secret.

## 4. Set the repository secrets

**Settings → Secrets and variables → Actions → Secrets**:

| Secret | What it is |
|---|---|
| `CLOUDFLARE_API_TOKEN` | From step 2. |
| `CLOUDFLARE_ACCOUNT_ID` | From step 2. |
| `VAPID_PRIVATE_KEY` | The private half from step 3, the whole JSON object. |

## 5. Set the repository variables

**Settings → Secrets and variables → Actions → Variables**. All four are
optional; each one you leave out keeps the default checked into
`packages/worker/dev/wrangler.jsonc`, which is this repository's own
deployment. **You want to set all four**, or you will deploy under this
repository's names.

| Variable | What it is |
|---|---|
| `WORKER_NAME` | Your Worker's name. Lowercase letters, digits and dashes. Also decides its `*.workers.dev` address. |
| `R2_BUCKET_NAME` | The R2 bucket holding mail and attachments. Same naming rules. Created for you on the first deploy. |
| `VAPID_PUBLIC_KEY` | The public half from step 3. |
| `ACCOUNT_RECOVERY_FROM` | The address password-reset mail is sent from, on your Resend-verified domain. Nobody reads replies to it. |

Leave `ACCOUNT_RECOVERY_FROM` unset and the "forgot password" flow stays off;
everything else works.

## 6. Deploy

Push to `main`, or run the **Deploy to Cloudflare** workflow by hand from the
Actions tab. The run creates the R2 bucket if it is missing, deploys the
Worker, and uploads the VAPID private key as a Worker secret.

The deploy log opens with a line per setting saying whether your value or the
default was used — check it the first time.

## 7. Point your mail at it

In the Cloudflare dashboard, **Email → Email Routing → Routes**, add a custom
address and set its action to **Send to a Worker**, choosing the Worker you
just deployed.

Mail is only accepted for a mailbox that already exists, so create the mailbox
in the app first. Anything addressed elsewhere is rejected at the door rather
than filed somewhere nobody watches.

## 8. Register, and set the outbound key

Open your Worker's URL. The **first** account to register becomes the
administrator, and registration closes behind it. Create the rest from the
admin screen.

Then, on `/admin`, paste your Resend API key. It is stored in your R2 bucket
rather than in a GitHub secret, so rotating it is not a redeploy.

## Keeping up to date

```bash
git remote add upstream https://github.com/worldwideskier-alpine/email-explorer-i18n.git
git pull upstream main
```

Your configuration is in GitHub's settings, not in the repository, so there is
nothing here to conflict. Push, and the workflow redeploys.

## What is optional

- **Push notifications.** Without a VAPID pair the app works; the browser
  notification toggle simply cannot be turned on.
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
