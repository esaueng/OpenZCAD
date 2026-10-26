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

The example enables `AI_DEPLOYMENT_FREE_ENABLED` and selects the free MiniMax
model through OpenRouter. Once you add `OPENROUTER_API_KEY`, **every verified
account can use your deployment's built-in assistant**, without Premium
membership or an email allowlist. Account quotas and shared OpenRouter free-tier
limits still apply. Prompts, context and selected attachments are sent to the AI
service under its data policies, as disclosed in Settings.

For a restricted assistant, set `AI_DEPLOYMENT_FREE_ENABLED` to `"false"` or
remove it before deploying, then grant access through Premium membership or
`AI_DEPLOYMENT_ALLOWED_EMAILS`. Paid models and custom endpoints always require
those access grants, even when the free rollout flag is enabled.

Run the offline preflight whenever the file changes:

```bash
pnpm selfhost:check
```

The preflight rejects unresolved placeholders, missing or duplicate bindings,
invalid Worker names and routes, secrets placed in `vars`, official OpenZCAD
resource identifiers, an attempt to run the official deployment from a fork,
and end-to-end encryption flags that are misspelled or turned on out of order
(see [End-to-end encryption](#end-to-end-encryption)). It does not contact or require access to the official Cloudflare account.

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

Deployment-funded AI is optional. The example's public free assistant needs an
`OPENROUTER_API_KEY` allowed to use `minimax/minimax-m3.1-flash:free`:

```bash
pnpm --filter @openzcad/web exec wrangler secret put OPENROUTER_API_KEY --config ../../wrangler.selfhost.jsonc
```

For a restricted assistant, disable the public free rollout flag as described
above. Then use the provider key selected by `AI_PROVIDER` and an authenticated
Premium account or a Free account in the optional allowlist:

```bash
pnpm --filter @openzcad/web exec wrangler secret put AI_DEPLOYMENT_ALLOWED_EMAILS --config ../../wrangler.selfhost.jsonc
```

Use `OPENAI_API_KEY` or `AI_API_KEY` instead when the selected provider requires
it. Without a deployment provider key, signed-in users may instead store their
own provider token. Review the secret names before every deployment:

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
pnpm --filter @openzcad/web exec mkdir -p backups
pnpm --filter @openzcad/web exec wrangler d1 export DB --remote --config ../../wrangler.selfhost.jsonc --output backups/openzcad-backup.sql
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

## End-to-end encryption

OpenZCAD can encrypt project data in the browser before it reaches your
Worker ([ADR-024](adrs/ADR-024-end-to-end-encrypted-projects.md)). Every
encryption flag ships closed, in the official deployment and in
`wrangler.selfhost.example.jsonc`. Read this section before turning any of
them on: once an account encrypts a project, neither you nor anyone else can
recover it for a user who loses every unlock method.

### What the server still sees

Encryption protects project content, not everything about it. Your Worker,
D1 database, R2 bucket and Durable Objects still hold, in plaintext:

- account emails and display names
- member lists and roles
- project and revision counts, blob sizes and counts
- timestamps, version numbers and save cadence
- presence during live editing
- schema versions and the envelope header fields
- each user's device list: device labels, when devices and unlock methods were
  added or removed, and their public keys

Project names, checkpoint names, revision reasons, upload file names,
thumbnails, measurements, workspace view state and archived exports are
encrypted. R2 object keys use opaque ids only.

Your backups therefore hold ciphertext plus the metadata above. A D1 export or
R2 copy of an encrypted project is unreadable without a member's keys, to you
and to anyone who obtains the backup. A browser remembers the newest version
it has seen of each project and refuses an older one as a rollback, so
restoring a backup older than what a member has already opened locks that
member out of the restored project rather than rewinding it.

The built-in assistant cannot read ciphertext. On an encrypted project it asks
each user once per project, listing exactly what leaves the device, before any
request reaches the AI provider you configured.

### Requirements

- **Migrations 0029 through 0043.** Apply every tracked D1 migration before
  turning a flag on; `pnpm deploy:selfhost` applies them before it publishes
  code. The encryption migrations are `0029_e2ee_account_keys.sql` through
  `0043_e2ee_reverse_staging.sql`. There is no `0035`: that number is an
  intentional gap, not a missing file. While a migration a flag needs is
  missing, its routes answer 503 and `/api/e2ee/config` reports the feature as
  off.
- **HTTPS.** Key handling uses WebCrypto, which browsers expose only in a
  secure context. Serve the app from the HTTPS origin in `PUBLIC_APP_ORIGIN`
  (a custom domain or `workers.dev`); over plain HTTP on any host other than
  `localhost`, browsers cannot create or unlock keys.
- **A stable hostname.** Passkeys are registered with the exact hostname as
  their relying party, and each browser keeps its device keys in storage for
  that origin. If you move to another domain, or from `workers.dev` to a custom
  domain, existing passkeys stop unlocking and every browser starts without
  its device keys. Users then unlock with their recovery key and add their
  passkeys again. Choose the final domain before enabling encryption, and warn
  users before any later move.
- **The shipped Content Security Policy.** The MLS engine and the encrypted
  document decoder run as module Workers loaded from your origin, and MLS runs
  in WebAssembly. `apps/web/public/_headers` already allows this with
  `script-src 'self' 'wasm-unsafe-eval'` and `worker-src 'self' blob:`. If you
  put another proxy or CDN in front of the Worker, keep those directives and do
  not add a stricter policy on top.

### Flags

Set each flag in `vars` as the string `"true"` or `"false"`, and turn them on
one deployment at a time in this order. A flag opens nothing unless the one
before it is on. `pnpm selfhost:check` refuses a configuration in which a flag
is on while its predecessor is off, any `E2EE_` name this release does not
read (a misspelled flag would otherwise stay off without a word; the error
names the closest flag), and any value that is not a recognised string: an
unquoted JSON `true` reaches the Worker as a boolean, which it reads as off.

1. `E2EE_KEYS_ENABLED`: account keys, device lists, passkeys, the required
   recovery key and device approval, under Settings › Encryption.
2. `E2EE_PROJECTS_ENABLED`: encrypted projects. Each account opts in with
   Settings › Encryption › Encrypt new projects; once it does, your server
   refuses new plaintext projects for that account.
3. `E2EE_MIGRATION_ENABLED`: owners move their existing plaintext projects to
   encrypted storage.
4. `E2EE_DEFAULT_ON` (planned, not in this release): new projects encrypted for
   every account.
5. `E2EE_PLAINTEXT_FROZEN` (planned, not in this release): plaintext writes
   refused.

This version does not read the two planned flags, so the preflight accepts
them only as `"false"`. A later Phase 8 release adds them after the outside
review of the cryptography and key flows.

`E2EE_REVERSE_ENABLED` is an optional, beta-only path that needs step 3. It
lets an owner turn an encrypted project back into plaintext while nobody else
holds it and the owner's "Encrypt new projects" opt-in is off. A later release
removes it; after that the only way out is the export described below.

`E2EE_CANARY_EMAILS` is a Worker secret, never a `var`. It opens the key routes
to the listed accounts while `E2EE_KEYS_ENABLED` stays off, which is how the
official beta stages its rollout. The self-host preflight cannot see secrets,
so it does not accept `E2EE_PROJECTS_ENABLED` while `E2EE_KEYS_ENABLED` is off;
try encryption on a separate test instance instead.

After each deployment, sign in and open `/api/e2ee/config`. It reports
`enabled` (the key routes) and `projectsEnabled`, and adds `migrationEnabled`
and `reverseEnabled` once each is on and its migration is installed.

Turning flags off again, in the reverse order, deletes nothing. While
`E2EE_PROJECTS_ENABLED` is off, encrypted projects cannot be opened. While
`E2EE_MIGRATION_ENABLED` is off, the hourly sweep of project migrations stops,
so a project whose plaintext purge had not finished keeps that leftover
plaintext until the flag is on again.

### Recovery and data loss

- **No escrow.** The server never holds a key that decrypts a project. A user
  who loses their recovery key, every passkey and every approved device loses
  their encrypted cloud projects. You cannot recover them, inspect them, or
  answer a support request from the stored data; local copies on the user's
  devices remain.
- **Leaving encryption.** During the beta an owner can use the reverse path if
  you enable it. Otherwise, and always once it is removed, the exit is to
  export each project as an `.openzcad` file (a plaintext file the user keeps)
  and delete it from the cloud.
- **Plaintext retained after migration.** Moving a project to encrypted
  storage deletes its plaintext from D1, R2 and the collaboration room. D1 Time
  Travel and the room's point-in-time recovery (it is a SQLite-backed Durable
  Object) can keep that plaintext for up to 30 days afterwards, and a backup
  you took before the migration keeps it until you delete the backup. Tell
  your users.

### Rollout on an instance with plaintext projects

1. Back up D1 and R2 as described above, update, and confirm that the
   deployment applied migrations 0029 through 0043.
2. Set `E2EE_KEYS_ENABLED` to `"true"`, run `pnpm selfhost:check`, deploy, and
   check `/api/e2ee/config`. With a test account, set up encryption, save the
   recovery key, and add a passkey and a second device.
3. Set `E2EE_PROJECTS_ENABLED` to `"true"` and deploy. Accounts can now opt in
   to encrypting new projects.
4. Set `E2EE_MIGRATION_ENABLED` to `"true"` and deploy. Each owner encrypts
   their projects from Settings › Encryption › Encrypt existing projects: the
   owner's browser encrypts every retained revision and file, and only then
   does the Worker delete the plaintext. The server encrypts nothing itself, so
   a project stays plaintext until its owner does this.
5. Watch the hourly cron. It finishes, a few at a time, purges and abandons
   that a browser left idle for an hour. These read-only queries show progress:

   ```bash
   pnpm --filter @openzcad/web exec wrangler d1 execute DB --remote --config ../../wrangler.selfhost.jsonc --command "SELECT storage_format, COUNT(*) FROM projects GROUP BY storage_format"
   pnpm --filter @openzcad/web exec wrangler d1 execute DB --remote --config ../../wrangler.selfhost.jsonc --command "SELECT direction, state, COUNT(*) FROM e2ee_project_migrations GROUP BY direction, state"
   ```

   `storage_format` 1 is plaintext and 2 is encrypted. A row that stays in
   `cutover` or `purging` for more than a few hours still has plaintext to
   delete; check the Worker logs for the scheduled run.

6. Encrypting new projects by default and freezing plaintext writes are later
   Phase 8 steps. They wait for an outside review and are not available in
   this release.
