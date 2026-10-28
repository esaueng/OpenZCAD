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
them on: you cannot recover encrypted content from server storage for a user
who loses every unlock method. Solo projects are then lost apart from local
copies; a shared project's remaining members can still open and export it
for the user.

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

- **Migrations 0029 through 0044.** Apply every tracked D1 migration before
  turning a flag on; `pnpm deploy:selfhost` applies them before it publishes
  code. The encryption migrations are `0029_e2ee_account_keys.sql` through
  `0044_e2ee_project_authority.sql`. This includes account-authenticated MLS
  roots for devices without a live MLS leaf. There is no `0035`: that number is an
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

**Upgrading an experimental E2EE installation across migration 0044:** old
version-1 key archives have no independently authenticated MLS roots. Migration
0044 deliberately aborts with `E2EE_AUTHORITY_CUTOVER_REQUIRED` while any MLS
group or unfinished encryption staging remains. The supported deploy commands
apply migrations before publishing code, so retain the prior release and its
0043 schema if this guard fires. Do not bypass the guard, fabricate authority
records, delete groups, or publish the new bundle against the old schema.

Before upgrading such an installation, arrange an owner-approved maintenance
transition on the prior release. Keep default-on and plaintext freeze off;
clear each account's encryption opt-in while the project flag is still on.
Owners must complete or abandon pending migrations. The prior release's
**Stop project encryption** flow can carry a solo project's head, source files
and retained revisions through its verified reverse migration and purge. For
a shared project, first have the owner explicitly authorize and remove its
other members, invitations and share links; that flow refuses a project that
still shares access. This transition temporarily restores server-readable
content, so it requires the owners' explicit consent and a private recovery
backup. If that is unacceptable, remain on the prior release until a separately
reviewed encrypted-to-encrypted upgrader is available.

Confirm that `SELECT COUNT(*) FROM e2ee_project_groups` is zero before retrying
0044. Then deploy the new release, re-encrypt through the normal verified
migration flow, and restore sharing with new verified invitations and links.
Check head content, source files and retained revisions in the owner browser
before considering the transition complete. This is a gated format change;
0044 does not silently convert old projects. Production activation still
requires written outside-review clearance.

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
4. `E2EE_DEFAULT_ON`: the Worker requires encrypted new projects for every
   eligible account, refuses opting out and new plaintext sharing, and closes
   reverse migration. It requires step 3. Keep it off until the browser's
   default-on migration flow and the outside review are complete.
5. `E2EE_PLAINTEXT_FROZEN`: deployment-wide plaintext content and upload writes
   refused, including old REST clients and existing room sockets. Legacy reads,
   erasure and encrypted migration stay available. This requires global keys
   and step 4 in preflight; it cannot be scoped to canary accounts. Keep it off
   until the legacy reader and the reviewed migration rollout are qualified.

The default-on and freeze Worker gates are implemented behind their flags;
that is not completion of the rollout or the outside review of the
cryptography, key flows and pinned MLS version. Preflight checks configuration
consistency; it cannot certify that the outside review is complete.

`E2EE_REVERSE_ENABLED` is an optional, beta-only path that needs step 3. It
lets an owner turn an encrypted project back into plaintext while nobody else
holds it and the owner's "Encrypt new projects" opt-in is off. Keep this flag
off while default-on is enabled; the preflight rejects enabling both. A later release
removes it; after that the only way out is the export described below.

`E2EE_CANARY_EMAILS` is a Worker secret, never a `var`. It opens the key routes
to the listed accounts while `E2EE_KEYS_ENABLED` stays off. The official beta
now offers opt-in encryption to every authenticated account; the secret remains
available as a scoped fallback if global keys are closed again. The self-host
preflight cannot see secrets,
so it does not accept `E2EE_PROJECTS_ENABLED` while `E2EE_KEYS_ENABLED` is off;
try encryption on a separate test instance instead.

After each deployment, sign in and open `/api/e2ee/config`. It reports
`enabled` (the key routes) and `projectsEnabled`, and adds `migrationEnabled`,
`reverseEnabled` and `defaultOn` once each is on and its required migrations
are installed. `plaintextFrozen: true` reports the global freeze even if an
account's key routes are closed. A configuration error therefore cannot
silently reopen plaintext writes.

Turning flags off deletes nothing, but clear account opt-ins before closing
the project routes:

1. If `E2EE_DEFAULT_ON` is on, set it to `"false"` and deploy with
   `E2EE_KEYS_ENABLED` and `E2EE_PROJECTS_ENABLED` still on. Turn off
   `E2EE_PLAINTEXT_FROZEN` in the same deployment, before attempting any
   plaintext recovery write. Check that
   `/api/e2ee/config` no longer reports `defaultOn: true`; the default-on gate
   otherwise refuses the account opt-out required next.

2. While `E2EE_KEYS_ENABLED` and `E2EE_PROJECTS_ENABLED` are still on, have
   every opted-in account turn off Settings › Encryption › Encrypt new
   projects. This saves an authenticated preference; turning off a deployment
   flag does not clear it. Confirm that no opt-ins remain with this read-only
   query against your self-host configuration:

   ```bash
   pnpm --filter @openzcad/web exec wrangler d1 execute DB --remote --config ../../wrangler.selfhost.jsonc \
     --command "SELECT COUNT(*) AS opted_in_accounts FROM e2ee_project_preferences WHERE encrypt_new_projects = 1"
   ```

   Wait for the count to reach zero before disabling project encryption. Keep
   it enabled if an opted-in account has not cleared its preference.

3. Turn off `E2EE_REVERSE_ENABLED`, then `E2EE_MIGRATION_ENABLED`, then
   `E2EE_PROJECTS_ENABLED`, and finally `E2EE_KEYS_ENABLED`, checking the
   configuration before deploying. While project encryption is off, encrypted
   projects cannot be opened. Turning off migration also stops its hourly
   sweep: any unfinished plaintext purge keeps that leftover plaintext until
   migration is enabled again.

**If project encryption was already turned off with opt-ins remaining:**
migration 0031's database trigger still refuses plaintext creates for those
accounts (`ENCRYPTED_PROJECTS_REQUIRED`), and the preference route is closed,
so they cannot opt out. Re-enable `E2EE_KEYS_ENABLED`, then
`E2EE_PROJECTS_ENABLED`, check `/api/e2ee/config`, and have those accounts
unlock encryption and clear their opt-ins as in step 2, with `E2EE_DEFAULT_ON`
off. Migration and reverse
can stay off during this recovery. Confirm the count is zero, then resume the
shutdown order. Do not drop the trigger or edit the MAC-protected preference
rows directly.

### Recovery and data loss

- **No escrow.** The server never holds a key that decrypts a project, so you
  cannot recover, inspect or answer a support request from the stored data. A
  user who loses their recovery key, every passkey and every approved device
  loses access to their encrypted cloud projects. Projects nobody else is a
  member of are then gone, apart from local copies on the user's devices. A
  shared project's remaining members still hold its key: one of them can open
  it and export an `.openzcad` backup for the user.
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
   deployment applied migrations 0029 through 0044.
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

6. Keep `E2EE_DEFAULT_ON` and `E2EE_PLAINTEXT_FROZEN` off until the outside
   reviewer has confirmed in writing that every P0 and P1 is resolved. Qualify
   the automatic browser migration, legacy reader, interrupted-purge recovery
   and export/restore flow on a separate instance first. After clearance and
   rollout authorization, enable `E2EE_DEFAULT_ON` with keys, projects and
   migration still on, and reverse migration off. Verify automatic migration
   and resolve owners or members waiting for keys before enabling
   `E2EE_PLAINTEXT_FROZEN` in a later deployment. Confirm legacy reads and
   encrypted saves/uploads with the freeze on. Keep the migration sweep on
   until every plaintext purge is complete. Code availability and a passing
   preflight do not supply outside-review clearance or production activation
   authorization; the official deployment keeps both flags off.
