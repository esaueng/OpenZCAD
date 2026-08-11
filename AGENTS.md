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
`brepkit-wasm` tarball. CI's `validate` job then runs these gates in order:

```bash
pnpm lint
pnpm typecheck
pnpm test:coverage
pnpm test:web
pnpm build
pnpm exec playwright install --with-deps chromium
pnpm test:e2e
```

The Playwright install downloads Chromium and may install system packages; do
not run it where network or system changes are unavailable. `pnpm test:e2e`
builds and serves the web app and is the slow gate (about five minutes in the
2026-08-11 Linux CI run). The separate geometry parity job runs:

```bash
pnpm test:parity-corpus
```

Changes touching the desktop workflow, either app, shared packages, the root
manifest/lockfile, or `script/build_and_run.sh` also trigger the Apple Silicon
workflow. Its package-specific checks are:

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

- Root Vitest and web Vitest are separate projects. `pnpm test:coverage`
  covers `test/**/*.test.ts` and package-owned `*.test.ts`; it does not cover
  `apps/web`'s happy-dom suites, so `pnpm test:web` is independently required.
- Parity files intentionally use `test/parity/**/*.spec.ts`. Renaming one to
  `*.test.ts` silently moves it into the root pool instead of the serial parity
  job configured by `test/parity/vitest.corpus.config.ts`.
- The top-level `pnpm build` is more than a Vite build: it also runs
  `scripts/report-bundle-sizes.mjs --check`. Do not substitute the filtered web
  build when validating a change.
- `pnpm deploy:beta` is not a validation command. It applies remote D1
  migrations before deploying the Worker and therefore needs credentials and
  explicit deployment authorization.
- `packages/kernel-adapter/package.json` follows the BrepKit branch, but frozen
  installs use the one immutable commit in `pnpm-lock.yaml`. The scheduled
  `.github/workflows/update-brepkit.yml` updater permits only a lockfile diff;
  do not hand-edit the resolved SHA. Any kernel update still needs the full CI
  matrix, especially `pnpm test:parity-corpus` and Playwright.

## Enforced boundaries

TypeScript strictness is enforced by `pnpm typecheck`, and ESLint enforces the
rules in `eslint.config.mjs`. There is currently no dependency-boundary lint
rule: package-direction claims are design intent, not an automated CI gate.
