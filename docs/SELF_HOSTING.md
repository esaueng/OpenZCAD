# Self-hosting OpenZCAD

The root `wrangler.jsonc` belongs to the official OpenZCAD deployment. It
contains public or non-secret production identifiers, not credentials. Those
identifiers do not grant access, but a self-hoster must not deploy that file or
reuse its Worker, D1, R2, email, Turnstile, or domain values.

Use `wrangler.selfhost.jsonc` for an independent deployment. It is gitignored,
and every self-host command names it explicitly.

## Prerequisites

- Node.js `^20.19.0` or `>=22.12.0`
- pnpm 10.8.0 (the version declared in `package.json`)
- A Cloudflare account with Workers, D1, R2, Durable Objects, Email Routing and
  Email Sending, and Turnstile available
- A sender address on a domain configured for Cloudflare Email Routing
- Wrangler authentication for your account

Install the repository dependencies and confirm the active Cloudflare account:

```bash
pnpm install --frozen-lockfile
pnpm --filter @openzcad/web exec wrangler login
pnpm --filter @openzcad/web exec wrangler whoami
```

Do not continue if `wrangler whoami` shows the account that operates the
official OpenZCAD resources unless that is deliberately your account and you
have verified every self-host identifier.

## Create the configuration

```bash
cp wrangler.selfhost.example.jsonc wrangler.selfhost.jsonc
```

Replace every `<YOUR_...>` placeholder. Use a globally unique Worker name and
resource names owned by your Cloudflare account. `PUBLIC_APP_ORIGIN` must be a
complete HTTPS origin with no trailing slash, for example
`https://cad.example.com` or the `workers.dev` URL Wrangler assigns.

Run the offline preflight whenever the file changes:

```bash
pnpm selfhost:check
```

The preflight rejects unresolved placeholders, missing or duplicate bindings,
invalid Worker names and routes, secrets placed in `vars`, official OpenZCAD
resource identifiers, and an attempt to run the official deployment from a
fork. It does not contact or require access to the official Cloudflare account.

## Provision Cloudflare resources

Create a D1 database and copy the returned `database_name` and `database_id`
into `wrangler.selfhost.jsonc`:

```bash
pnpm --filter @openzcad/web exec wrangler d1 create <YOUR_D1_DATABASE_NAME>
```

Create the R2 bucket and copy its name into the `ARTIFACTS` binding:

```bash
pnpm --filter @openzcad/web exec wrangler r2 bucket create <YOUR_R2_BUCKET_NAME>
```

OpenZCAD currently uses no KV namespace or Queue. Do not create either. The
tracked config already declares the `PROJECT_ROOM` Durable Object binding and
its `v1` SQLite migration; Wrangler applies that class migration on the first
Worker deployment. Keep the binding name, class name, and migration tag.

The hourly cron in the example runs the existing expired-upload cleanup. You
may change its schedule, but keep a schedule if uploads are enabled. Cron
schedules are UTC.

## Configure email and Turnstile

In the Cloudflare dashboard:

1. Enable Email Routing for your sender domain.
2. Verify the address used for `AUTH_EMAIL_FROM` and
   `PROJECT_INVITATION_EMAIL_FROM`.
3. Keep the `EMAIL` binding's `allowed_sender_addresses` limited to that exact
   address.
4. Create a managed Turnstile widget and allowlist the hostname from
   `PUBLIC_APP_ORIGIN`, plus `localhost` and `127.0.0.1` when needed for local
   testing.
5. Put the public site key in `TURNSTILE_SITE_KEY`. Never put the Turnstile
   secret key in the config.

OAuth providers are not implemented by this repository. Hosted authentication
uses Turnstile-protected, single-use email codes.

## Set Worker secrets

Set each value interactively so it does not enter shell history. The two
peppers should be random and stable. `SETTINGS_ENCRYPTION_KEY` must remain
stable or users' encrypted personal AI credentials become unreadable.

```bash
pnpm --filter @openzcad/web exec wrangler secret put AUTH_OTP_PEPPER --config ../../wrangler.selfhost.jsonc
pnpm --filter @openzcad/web exec wrangler secret put TURNSTILE_SECRET_KEY --config ../../wrangler.selfhost.jsonc
pnpm --filter @openzcad/web exec wrangler secret put SETTINGS_ENCRYPTION_KEY --config ../../wrangler.selfhost.jsonc
pnpm --filter @openzcad/web exec wrangler secret put AI_IDENTITY_PEPPER --config ../../wrangler.selfhost.jsonc
```

Deployment-funded AI is optional. Without both a provider key and an allowlist,
it fails closed; signed-in users may instead store their own provider token.
To enable it, set the provider secret selected by `AI_PROVIDER` and an explicit
email allowlist:

```bash
pnpm --filter @openzcad/web exec wrangler secret put OPENAI_API_KEY --config ../../wrangler.selfhost.jsonc
pnpm --filter @openzcad/web exec wrangler secret put AI_DEPLOYMENT_ALLOWED_EMAILS --config ../../wrangler.selfhost.jsonc
```

Use `OPENROUTER_API_KEY` or `AI_API_KEY` instead when the selected provider
requires it. Review the secret names before every deployment:

```bash
pnpm --filter @openzcad/web exec wrangler secret list --config ../../wrangler.selfhost.jsonc
```

The command returns secret names only. Confirm the four required names above;
do not print or copy their values into the repository.

## Apply migrations and validate

Apply the tracked D1 migrations to the database bound as `DB`:

```bash
pnpm selfhost:check
pnpm --filter @openzcad/web exec wrangler d1 migrations apply DB --remote --config ../../wrangler.selfhost.jsonc
```

Run the repository checks and a no-deploy Worker build:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:parity-corpus
pnpm build
pnpm --filter @openzcad/web exec wrangler deploy --dry-run --config ../../wrangler.selfhost.jsonc
```

Local CAD development intentionally uses the isolated development config, not
the hosted configuration:

```bash
cp apps/web/.dev.vars.example apps/web/.dev.vars
pnpm dev:web
```

Keep real local secrets only in the gitignored `.dev.vars` file. To exercise
the self-host Worker configuration locally after its placeholders are resolved:

```bash
pnpm --filter @openzcad/web exec wrangler dev --config ../../wrangler.selfhost.jsonc
```

## Domain selection

The simplest first deployment uses the account's `workers.dev` subdomain.
After Wrangler reports the URL, set `PUBLIC_APP_ORIGIN` to that exact HTTPS
origin, rerun the preflight, and redeploy.

For a custom domain, activate it in the same Cloudflare account, then uncomment
the `routes` example and replace `<YOUR_DOMAIN>`. A custom-domain route pattern
is the hostname only; it must not include `https://`. Keep
`PUBLIC_APP_ORIGIN` as the complete `https://` origin. Update the Turnstile
hostname allowlist at the same time.

## Deploy an independent instance

The self-host command validates the config, builds the application, applies D1
migrations, and only then deploys the Worker. It never reads `wrangler.jsonc`.

```bash
pnpm deploy:selfhost
```

This is a real deployment to the Cloudflare account shown by `wrangler whoami`.
Review the account, local config, secret names, and pending D1 migrations before
running it.

Verify the returned host:

```bash
curl --fail --show-error https://<YOUR_DOMAIN>/api/health
curl --fail --show-error https://<YOUR_DOMAIN>/api/auth/config
```

Then test email sign-in, project creation and reload, an upload/download round
trip, sharing and collaboration with two test accounts, and AI only if you
configured a provider. Confirm the Worker, D1, R2, Durable Object, email, and
Turnstile resources shown in Cloudflare all belong to your account.

## Update without deleting data

Use the same `wrangler.selfhost.jsonc`, Worker name, D1 database, R2 bucket,
Durable Object binding, and stable secrets for every update:

```bash
git pull --ff-only
pnpm install --frozen-lockfile
pnpm selfhost:check
pnpm test
pnpm deploy:selfhost
```

The deploy command applies forward D1 migrations before publishing code. Do not
delete or recreate D1, R2, or the Worker to update OpenZCAD. Review migration
files before upgrading and test a backup when an update changes storage.

Export D1 before a migration or major upgrade:

```bash
pnpm --filter @openzcad/web exec wrangler d1 export DB --remote --config ../../wrangler.selfhost.jsonc --output openzcad-backup.sql
```

The SQL export can contain user data and must remain private and outside Git.
Back up R2 through Cloudflare's S3-compatible API or your existing object
backup tool. Durable Object storage is not included in the D1 export; plan a
maintenance window and application-level migration if a future release changes
its schema. The repository does not include an automated production-data
restore command, so rehearse recovery in separate resources before relying on
it.

Never run `wrangler d1 delete`, `wrangler r2 bucket delete`, or `wrangler
delete` as part of an update.
