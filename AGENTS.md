# Working agreements

Complete the requested work. Infer scope from context, make reasonable
implementation choices, and continue until finished or genuinely blocked.
Keep investigation-only requests read-only.

An explicit request or prior approval authorizes that action. Do not ask
again. Ask only when consequential ambiguity remains or an additional action
falls outside the authorized scope. Complete independent work while waiting.

Follow repository conventions. Keep changes focused. Preserve units,
tolerances, defaults, formats, and public contracts unless changes are
required. Label approximations and flag breaking changes or new dependencies.

Run required checks and tests proportional to the change. Add regression
coverage for bug fixes. Do not weaken assertions or bypass protections.
Attempt routine recovery from missing tools or Git refs before reporting a
blocker. Distinguish local validation from production verification.

Keep secrets, private instructions, and identifying information out of shared
artifacts. Inspect staged content and metadata before committing. Use the
approved repository Git identity.

## Delivery

- Use a branch and a ready-for-review pull request for repository changes.
- A merge request authorizes the identified pull request’s merge and its
  existing automatic deployment. Mention that consequence and proceed
  without another confirmation.
- Before merging, verify the current head, mergeability, reviews, and required
  checks. Wait for pending checks. Existing approval remains valid for the
  authorized change.
- Bypassing CI requires explicit authorization for the specific pull request.
  Disclose affected checks and risks; preserve review requirements.
- Standalone production deployments and manual migrations require
  authorization. An explicit request to perform them is sufficient.
- Resolve the target repository, environment, and account from configuration
  and context. Ask only if the target remains ambiguous.

Report the outcome briefly, followed by verification, actual blockers, and
relevant links. Never claim an unverified result passed.

---

# OpenZCAD Agent Guide

## Project

OpenZCAD is a browser-first parametric CAD application with replayable feature
history, exact solid modeling, local persistence, and optional cloud services.
This pnpm monorepo contains the React/Three.js/Cloudflare web application, a
Tauri macOS host, and shared TypeScript packages for its CAD model and runtime.

## Planning

[ROADMAP.md](ROADMAP.md) is the only priority and delivery-status ledger.
Select a master ID, read its supporting specification, and update that row
with evidence in the implementation PR. Older plans retain design/history,
not independent work queues.

## Required verification

Run commands from the repository root. A cold clone first needs:

```bash
pnpm install --frozen-lockfile
```

That install needs network access because `pnpm-lock.yaml` pins a GitHub-hosted
`remus-wasm` tarball. Pull requests, merge groups, and manual dispatches run
these gates, which the required `checks / validate` check aggregates:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:parity-corpus
pnpm build
```

They run as three parallel jobs: `quality` (lint, typecheck), `unit` (the root
Vitest project, `pnpm exec vitest run`) and `validation` (the web Vitest
project via `pnpm test:web`, the parity corpus, the build). Together `unit`
and `validation` are `pnpm test`. The Playwright suite runs as six shards:
in parallel with those jobs for queue candidates (`e2e-tests`), and only
after `quality` passes on pull requests (`e2e-tests-pr`), so a lint-red or
superseded push does not hold six runners. Each shard takes the spec files
`scripts/e2e-shards.mjs` assigns it (every shard runs
`pnpm exec playwright install --with-deps chromium` first), and an `e2e` gate
job aggregates the shards for branch protection. Shards are balanced by the
per-file seconds in `test/e2e/shard-weights.json`; a new spec file needs no
entry (it gets a default weight), and each shard uploads its Playwright JSON
report as an `e2e-report-N` artifact, so after the suite drifts, download
those and run `node scripts/e2e-shards.mjs --update <reports>` to rebalance.

The Playwright install downloads Chromium and may install system packages; do
not run it where network or system changes are unavailable. `pnpm test:e2e`
builds and serves the web app and is the slow gate. CI intentionally does not
rerun after merge while the product is in beta. Validate the pull-request head
before enqueueing, then verify the separate `merge_group` run on the queue
candidate. Use the manual dispatch when a pull-request CI rerun is needed; a
manual run does not replace the queue candidate’s required checks.

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
- `packages/kernel-adapter/package.json` pins the paired Remus packages, and
  frozen installs use their shared immutable commit in `pnpm-lock.yaml`.
  `.github/workflows/update-remus.yml` checks for the latest paired package
  release when Remus publishes it, with a five-minute schedule and manual
  dispatch as fallbacks. It opens a review PR for a targeted manifest and
  lockfile update; do not hand-edit the
  resolved SHA. Any kernel update still needs the full CI matrix, especially
  `pnpm test:parity-corpus` and Playwright.

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

## Merge gate

Main uses the active `Bounded merge queue` ruleset: two concurrent queue
builds, `SQUASH`, `ALLGREEN`, one or two PRs per merge, no minimum-group wait,
a 180-minute check timeout, and no bypass actors. Squash is the only enabled
merge method; commit titles use the PR title and bodies use its description.
See [.github/merge-queue.md](.github/merge-queue.md) for the enqueue procedure.

Branch protection requires `checks / validate`, `checks / e2e`,
`commit-privacy`, `history-privacy`, and Cloudflare `verify` (the `verify` job in the
`Cloudflare version` workflow), with both privacy checks bound to the dedicated Esau History Privacy App and
the other checks bound to GitHub Actions. Review
requirements remain unchanged (currently zero required approvals), and
conversation resolution is required. The queue validates candidates against current main, so strict
status checks are disabled: a branch behind main does not need a manual
merge or rebase solely to enter the queue. Resolve actual conflicts and
rerun checks on any changed PR head.

- **Arm auto-merge on authorized PRs; GitHub enqueues them.** With the
  merge queue, auto-merge adds the PR to the queue once its required
  contexts pass, so there is no polling for green or manual
  `enqueuePullRequest` call. Before arming it, address reviews, comments
  and threads, and confirm the head you are authorizing. Arm it with that
  head pinned: `enablePullRequestAutoMerge` with `expectedHeadOid` and
  `mergeMethod: SQUASH`, or `gh pr merge <n> --auto --squash
  --match-head-commit <sha>`. Never use a direct/admin merge, a bypass
  actor, or `jump`. Queue configuration is not authorization to arm
  unrelated PRs. An authorized merge still triggers the existing automatic
  deployment workflows; standalone deployment or migration needs its own
  authorization.
- **Auto-merge stays armed across later pushes.** Pushes from users with
  write access keep it enabled, and the queue then takes the new head once
  its required contexts pass. Before pushing a change outside the authorized
  scope, disable auto-merge. Advisory checks (Workers Builds, dependency
  audits on manifest or lockfile changes, public commit metadata) do not
  gate the queue: if one fails before the merge, disable auto-merge and
  address it. A passing check suite alone is still not evidence of a green
  head; read the individual runs when reporting.
- **Verify the separate queue run.** Match the `merge_group` run’s head SHA
  to the candidate reported by the queue, not the original PR head. The
  five required checks, including Cloudflare `verify`, must pass on that
  candidate before GitHub merges it. A pending or failing `verify` blocks
  the queue merge. Confirm Cloudflare `upload` is skipped. Verify
  the final merged PR and squash commit; do not report enqueueing as a
  completed merge. If the queue removes an entry after a required-check
  failure, inspect and repair or retry it before re-enqueueing.
- **Preserve every protection.** Keep required contexts and app bindings,
  reviews, and conversation resolution. The queue ruleset has no bypass
  actors, and classic protection also enforces administrators. Keep
  Cloudflare `verify` required on both the PR head and merge-group candidate.
  When restoring queue configuration, activate and verify the queue before
  disabling strict status checks; keep all other protections in place.
- **Recover missing CI without deploying.** A conflicting PR has no merge
  ref for `pull_request` workflows; resolve the conflict first. If the exact
  PR head has no CI run, dispatch `ci.yml` and wait for its results. Do not
  dispatch `Cloudflare version` as a check rerun: manual dispatch permits a
  real version upload. Its `verify` job already runs for pull requests and
  merge groups, while `upload` is restricted to main pushes and manual
  dispatches. A manual CI run cannot substitute for a missing `merge_group`
  run; inspect the queue event and workflow triggers before retrying.

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
