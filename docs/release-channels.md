# Release channels

The hosted app runs as two Cloudflare Workers that share code but nothing
else.

| | Beta | Stable (production) |
| --- | --- | --- |
| Worker | `openzcad-beta` (`wrangler.jsonc`) | `openzcad-stable` (`wrangler.stable.jsonc`) |
| Address | `beta.zcad.app` | `zcad.app` (also `stable.zcad.app`) |
| D1 and R2 | `openzcad-beta`, `openzcad-beta-artifacts` | `openzcad-stable`, `openzcad-stable-artifacts` |
| Email sender | `noreply@beta.zcad.app` | `noreply@zcad.app` |
| Deploys from | `main`, on every merge | `stable`, only when promoted |
| Deploy command (Workers Builds) | `pnpm run deploy:beta` | `pnpm run deploy:stable` |
| Previews | `<branch>.dev.zcad.app` on staging data ([previews.md](previews.md)) | none |

Accounts, projects, secrets, sessions, rate-limit budgets and
collaboration rooms are separate. A user of one channel has no account on
the other. Glimpse analytics report from beta only; stable has no
`GLIMPSE` service binding (both would report as app `openzcad`).

`scripts/validate-deployment-config.mjs` checks each config against its
channel (`--target official` for beta, `--target stable`). It refuses a
stable config that names a beta resource, shares a rate-limit namespace,
binds a service, turns Glimpse on, defines Previews, or uses another
channel's sender or origin. CI dry-runs both deploys on every PR.

## Promoting stable

`stable` only fast-forwards to a commit already on `main`, so it never
drifts. Pick a commit beta has been running, then:

```bash
pnpm promote:stable <sha> --dry-run   # lists the commits and new D1 migrations
pnpm promote:stable <sha>             # pushes stable; Workers Builds deploys it
```

The stable deploy applies that range's D1 migrations to `openzcad-stable`
before publishing, then checks `https://zcad.app/api/health` and
`build-meta.json` for the promoted commit. A GitHub ruleset blocks
force-pushes and deletion of `stable`.

An urgent fix merges to `main` like any change and is then promoted. To
ship it without the commits before it, cherry-pick onto `stable` by hand;
the next promotion then needs a merge instead of a fast-forward.

## Deploying by hand

`pnpm deploy:beta` and `pnpm deploy:stable` run the same steps as Workers
Builds: build, release-build check, migrations, deploy, verification.
Both need Cloudflare credentials and are production actions.
