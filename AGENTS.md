# OpenZCAD Agent Guide

## Project

OpenZCAD is a browser-first parametric CAD application with replayable feature
history, exact solid modeling, local persistence, and optional cloud services.
This pnpm monorepo contains the React/Three.js/Cloudflare web application, a
Tauri macOS host, and shared TypeScript packages for its CAD model and runtime.

## Required verification

Run commands from the repository root. A cold clone first needs:

```bash
pnpm install --frozen-lockfile
```

That install needs network access because `pnpm-lock.yaml` pins a GitHub-hosted
`remus-wasm` tarball. Pull requests and manual dispatches run a `validate`
job with these gates in order:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:parity-corpus
pnpm build
```

plus a parallel `e2e-tests` job that shards the Playwright suite four ways
(`pnpm test:e2e --shard=N/4`, each shard runs
`pnpm exec playwright install --with-deps chromium` first) and an `e2e` gate
job that aggregates the shards for branch protection.

The Playwright install downloads Chromium and may install system packages; do
not run it where network or system changes are unavailable. `pnpm test:e2e`
builds and serves the web app and is the slow gate. CI intentionally does not
rerun after merge while the product is in beta; validate the pull-request head
and use the manual dispatch when a hosted rerun is needed.

The Apple Silicon workflow is manual while the browser beta is the active
delivery target, and deliberately expensive to run — dispatch it only when
asked (see the merge-gate section below). Its package-specific checks are:

```bash
pnpm --filter @openzcad/web lint
pnpm --filter @openzcad/web exec vitest run src/lib/desktopBridge.test.ts
(
  cd apps/desktop/src-tauri
  cargo fmt --all -- --check
  cargo clippy --locked --target aarch64-apple-darwin --all-targets --all-features -- -D warnings
  cargo test --locked --target aarch64-apple-darwin --all-features
)
pnpm --filter @openzcad/desktop test:e2e
pnpm build:desktop
```

Those native checks require macOS, the Apple Silicon Rust target, and the Tauri
toolchain. CI additionally inspects the generated app and DMG architecture,
icon, signature, and disk-image validity; the authoritative commands are inline
in `.github/workflows/macos-desktop.yml`.

## Test and build gotchas

- Root Vitest and web Vitest are separate projects. `pnpm test` runs both;
  invoking root Vitest directly does not cover the web happy-dom suites.
- Parity files intentionally use `test/parity/**/*.spec.ts`. Renaming one to
  `*.test.ts` silently moves it into the root pool instead of the serial parity
  job configured by `test/parity/vitest.corpus.config.ts`.
- The top-level `pnpm build` is more than a Vite build: it also runs
  `scripts/report-bundle-sizes.mjs --check`. Do not substitute the filtered web
  build when validating a change.
- `pnpm deploy:beta` is not a validation command. It applies remote D1
  migrations before deploying the Worker and therefore needs credentials and
  explicit deployment authorization.
- `packages/kernel-adapter/package.json` follows the Remus branch, but frozen
  installs use the one immutable commit in `pnpm-lock.yaml`. The manual
  `.github/workflows/update-remus.yml` updater permits only a lockfile diff;
  do not hand-edit the resolved SHA. Any kernel update still needs the full CI
  matrix, especially `pnpm test:parity-corpus` and Playwright.

## Enforced boundaries

TypeScript strictness is enforced by `pnpm typecheck`, and ESLint enforces the
rules in `eslint.config.mjs`. There is currently no dependency-boundary lint
rule: package-direction claims are design intent, not an automated CI gate.

Markup keeps its styling contract through `test/css-class-coverage.test.ts`,
which fails when an element carries only class names no stylesheet defines —
the defect that shipped an unstyled Hole face list, three dead export spinners
and a bare viewport fallback in one release, none of which a type or unit test
can see. `node scripts/check-css-classes.mjs` runs the same check on its own.
An element styled entirely from a parent, a child, or a wrapper component
belongs in `UNSTYLED_ALLOWANCES` in that script together with the reason; an
entry that stops matching fails as stale, so the list cannot quietly rot.

**`main` is protected, but the protection is narrower than the merge gate.**
The repository is public, so branch protection is available on GitHub Free:
`main` requires the `validate` and `e2e` check runs to pass before a merge.
Three gaps remain, so the checks still have to be read by hand:
`Cloudflare version / verify` is not a required check, `enforce_admins` is
off (an admin merge bypasses the requirement), and the rule does not require
the branch to be up to date with `main`. Consequences:

- **Never `gh pr merge --auto` here.** Auto-merge fires the moment the
  *required* checks pass, so it never waits for `Cloudflare version /
  verify`. Merging before the shards reported has already put a red `main`
  in front of us once, before protection existed: #55 went in with three
  Playwright shards outstanding, and shard 3 was failing.
- **Read `gh pr checks` and see `validate`, `e2e`, and `Cloudflare version /
  verify` pass before merging.** `validate` is the slow one at roughly seven
  minutes. `e2e` is the aggregate over the four Playwright shards (it fails,
  rather than skips, when a shard fails), and `Cloudflare version / verify`
  proves the Worker config still dry-run deploys. Those three are the merge
  gate; `apple-silicon` is not one of them — see below.
- **Verify those from the check runs themselves, not from a passing check
  suite.** Several GitHub Apps report suites here, and the Cloudflare ones
  complete within a minute of a push — reading "suite succeeded" as "CI
  succeeded" will call a PR green while `validate` and the shards are still
  running.
- **Confirm a run exists for the PR's current head at all.** Protection
  blocks the merge while `validate` or `e2e` has not reported, but nothing
  guards `Cloudflare version / verify` the same way, and a pull request can
  sit with no `ci` run against the commit you are about to merge. Two causes
  have been seen: a PR conflicting with its base has no merge ref for
  `pull_request` workflows to run against, so none are scheduled until the
  conflict is resolved (#55 sat that way, its only green checks
  Cloudflare's); and some pushes produce no `synchronize` run even on a
  mergeable branch (#57's `8aad6c5` and `017b91d` heads got manual dispatches
  only, while its other heads triggered normally). Absence of red is not
  green — match a run's `head_sha` to the PR's, and dispatch `ci.yml`
  manually when none exists.
- **Do not manually dispatch `Cloudflare version` to fill that gap.** Its
  `upload` job is gated `if: github.event_name != 'pull_request'`, so a
  `workflow_dispatch` runs a real `wrangler versions upload`, which fails on
  absent credentials and leaves a red check that belongs to the dispatch
  rather than to the code. `verify` — the half that is a merge gate — already
  runs on `pull_request` on its own.

**Never dispatch `apple-silicon` unless it is explicitly asked for.** It is
macOS-runner time and costs real money, so it is `workflow_dispatch`-only and
stays that way: it does not run on pull requests, and its absence never blocks
a merge. Do not trigger it to be thorough, and do not report a PR as unverified
for want of it.

What it covers, for when someone does ask: it is the only check that exercises
the desktop shell, and `apps/desktop/e2e/cad-smoke.mjs` drives the real
WKWebView workspace — camera, wheel, selection. Neither Vitest nor Playwright
can see that surface, so a viewport or input change can pass every other suite
and still break the desktop app. That makes it worth requesting before desktop
distribution, or when a navigation or viewport change needs real WKWebView
evidence — but that call is the maintainer's to make, not an agent's.
