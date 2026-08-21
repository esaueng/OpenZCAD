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
delivery target. Run it before desktop distribution or when a change needs
real WKWebView evidence. Its package-specific checks are:

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

**No status check is required to merge.** The org is on GitHub Free and this
repo is private, so branch protection and rulesets are unavailable — GitHub
reports every open PR as mergeable regardless of CI. Two consequences:

- **Never `gh pr merge --auto` here.** With nothing required, "merge when
  checks pass" silently means "merge now"; it has already merged a PR while
  `apple-silicon` was still running.
- **Read `gh pr checks` and see `validate`, `e2e`, `Cloudflare version /
  verify`, and `apple-silicon` pass before merging.** `validate` is the slow
  one at roughly seven minutes. `e2e` is the aggregate over the four
  Playwright shards (it fails, rather than skips, when a shard fails), and
  `Cloudflare version / verify` proves the Worker config still dry-run
  deploys.

`apple-silicon` is the only check that exercises the desktop shell, and
`apps/desktop/e2e/cad-smoke.mjs` drives the real WKWebView workspace —
camera, wheel, selection. Neither Vitest nor Playwright can see that surface,
so a viewport or input change can pass every local suite and still break the
desktop app there. Expect that job to have an opinion about anything touching
navigation.
