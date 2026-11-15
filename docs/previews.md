# Worker Previews

The official Worker (`openzcad`) serves production at `zcad.app` and Worker
Previews at `<preview-name>.dev.zcad.app`. A Preview runs a branch's code
against staging resources, never production data. Cloudflare Access protects
Preview hostnames, so opening one asks for an Access sign-in first.

## What a Preview binds

A Preview inherits only `assets`, the compatibility settings and the Durable
Object classes and migrations from the top level of `wrangler.jsonc`. Every
binding and var it reads comes from the `previews` block:

| Binding | Preview resource |
| --- | --- |
| `DB` (D1) | `openzcad-preview`, shared by all Previews |
| `ARTIFACTS` (R2) | `openzcad-preview-artifacts`, shared by all Previews |
| `PROJECT_ROOM` (Durable Object) | A new namespace per Preview, created by Cloudflare |
| `EMAIL` | The production sender, so sign-in codes arrive |
| Rate limits | The production limits, in their own namespaces |
| `GLIMPSE` (service) | None; Preview analytics are off |

`PUBLIC_APP_ORIGIN` is unset in Previews, so invitation email answers 503
rather than linking people to production. Cron triggers never run in a
Preview, so expired upload sessions are not swept there.

`node scripts/validate-deployment-config.mjs --target official` (run by
`deploy:beta` and the unit tests) refuses a `previews` block that names the
production database, bucket or rate-limit namespaces, binds a service, turns
Glimpse on, points `PUBLIC_APP_ORIGIN` at production or weakens sign-in.
Other vars may differ from production on purpose, for example to try a flag
in a Preview first.

## Secrets

Previews do not see production secrets. The Preview base config holds its own
`AUTH_OTP_PEPPER`, `SETTINGS_ENCRYPTION_KEY`, `AI_IDENTITY_PEPPER` (random,
staging-only) and `TURNSTILE_SECRET_KEY` (the production widget's secret).
The Worker checks the Turnstile hostname against the request's own host, so a
Preview works only if the widget accepts `*.dev.zcad.app`. If sign-in fails
there with "The security check expired", add `dev.zcad.app` to the widget's
hostnames. A new Preview copies the base secrets when it is created; changing
one later reaches only Previews created after.

```bash
pnpm --filter @openzcad/web exec wrangler preview base-config secret list --config ../../wrangler.jsonc
pnpm --filter @openzcad/web exec wrangler preview base-config secret put NAME --config ../../wrangler.jsonc
```

`OPENROUTER_API_KEY` is not set, so the built-in assistant is unavailable in
Previews until it is added the same way.

## D1 migrations

`wrangler.preview-migrations.jsonc` names the same database as
`previews.d1_databases` (a unit test keeps them equal). Apply migrations
before deploying a Preview that adds one:

```bash
pnpm migrate:preview
```

All Previews share the database, so a migration applied from an unmerged
branch stays applied. Do not rename or rewrite a migration after it has
reached the staging database.

## Deploying a Preview

Workers Builds runs the Preview command for non-production branches when
**Settings → Builds → Builds for Preview branches** is on. A local Preview
needs a release build first:

```bash
pnpm build
pnpm --filter @openzcad/web exec wrangler preview --config ../../wrangler.jsonc --name my-branch
pnpm --filter @openzcad/web exec wrangler preview delete --config ../../wrangler.jsonc --name my-branch
```
