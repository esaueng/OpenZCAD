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
drifts. The **Promote stable** workflow moves it:

- **Daily**, at 10:00 UTC, to the latest `main` at that moment. A day with
  nothing new pushes nothing.
- **By hand**, to the latest `main` or to any commit on it:

```bash
pnpm promote:stable <sha> --dry-run                            # commits and new D1 migrations
gh workflow run promote-stable.yml --ref main                  # the latest main, now
gh workflow run promote-stable.yml --ref main -f commit=<sha>  # a chosen commit
```

The workflow runs in the `stable-promotion` environment and pushes
`stable` with that environment's deploy key. Workers Builds then deploys
it: the stable deploy applies that range's D1 migrations to
`openzcad-stable` before publishing (including on the daily run), then
checks `https://zcad.app/api/health` and `build-meta.json` for the
promoted commit.

Only that workflow can move `stable`:

- The `Stable channel: fast-forward only` ruleset blocks deletion and
  force-pushes, and restricts updates to deploy keys. It has no other
  bypass actors, so neither an admin nor an agent session can push
  `stable` directly.
- The only deploy key with write access is the workflow's, stored as the
  `STABLE_PROMOTION_DEPLOY_KEY` secret of the `stable-promotion`
  environment. That environment accepts runs from `main` only. It needs no
  approval, so the daily run is unattended; adding a required reviewer
  makes every run, daily included, wait for one.
- The script refuses a non-dry-run outside GitHub Actions, a ref instead of
  a SHA, a commit not on `origin/main`, and anything but a fast-forward.

An urgent fix merges to `main` like any change and is then promoted. There
is no direct path onto `stable`: shipping a fix without the commits before
it means editing the ruleset by hand, which should stay a rare,
deliberate act.

## Deploying by hand

`pnpm deploy:beta` and `pnpm deploy:stable` run the same steps as Workers
Builds: build, release-build check, migrations, deploy, verification.
Both need Cloudflare credentials and are production actions.
