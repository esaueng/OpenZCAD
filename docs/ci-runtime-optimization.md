# CI runtime optimization

The required checks live in `.github/workflows/checks.yml`, which `ci.yml`
calls from the same commit. They run a kernel declaration inside required
validation, partition root units over two runners, separate lint and
typecheck, and run critical plus affected coverage.
STEP parity, build/bundle checks, per-runner worker limits, isolation, browser
deadlines, retries and all six required contexts stay enforced.

Manifest additions preserve the existing baseline before using affected-test
selection. Missing discovery/history, removals, unknown inputs and dynamic
package assets require broader validation. Browser files changed by a PR run
all their cases. Newly affected browser specs use a conservative timing default;
the committed smoke baseline still requires complete timing metadata and
exact-once inventory tests. Six shards use refreshed
current-kernel timings; fewer shards or a smaller baseline require separate
qualification.

The dependency audit selects JavaScript and Rust jobs independently from the
exact change base. Schedules, manual requests and unavailable inputs run both.
Relevant main pushes retain advisory checks; UI-only main pushes do not rebuild
the audit tool. The Rust job downloads RustSec's fixed `cargo-audit` 0.22.2 Linux
x86_64 release, verifies its committed SHA-256 and version, then audits with a
fresh advisory database. The required dependency-review workflow is separate.

Routine successful unit/browser/bundle artifacts last seven days; failures
last fourteen. Browser retries retain traces and failure screenshots. Full
daily qualification retains its complete tests, coverage and single attempt.
Privacy audit scope, receipts and CodeQL overlay caches are unaffected.

## No serial preflight, lint on two runners

Every check used to wait for the hosted `plan` job, so a pull request paid
for two runner waits before its first test started (a median of two minutes
each under load, up to eight). Lint, typecheck, units, the build and the PR
browser shards now start with no dependency and each runs
`scripts/ci-selection.mjs` itself. `plan` still runs the kernel declaration
and still chooses the queue and manual browser set, and `validate` and `e2e`
still fail unless it succeeds.

Lint is the longest single step (222 s hosted). It runs as two partitions,
`apps` and `packages test types`, through `pnpm lint:paths`; each took 77 to
78 s locally against 158 s for the whole tree. ESLint's `--concurrency` was
rejected: one type-aware process peaks at 5.8 GB and every thread builds its
own program. `test/ci-checks.test.ts` holds the partitions to the paths of
`pnpm lint`.

## Hosted runners only

The checks previously ran through a versioned reusable workflow pinned by
commit, which could route jobs to a self-hosted runner group. That routing
was disabled here (`CI_FLEET_ENABLED=false`) and has been removed with
its queue-authorization job, runner isolation guard, routing policy scripts
and Git fixture setup. Every job runs on `ubuntu-24.04`. Running CI on
self-hosted runners again would need its own design: a same-commit workflow
gives a pull request control of the jobs, which is safe only on hosted
runners.

## Qualification and later work

Validate the staging PR and a separate activation PR on their exact heads.
Activation pins the new callee's landed main commit; it must also pass a
separate merge-group run. Compare PR and queue timing cohorts by kernel and
selection mode. A green PR run is not evidence that a queue candidate passed,
and no specific merge-time improvement is guaranteed before measurement.

CodeQL runs from `codeql.yml` (advanced setup) on pushes to `main`, weekly and
on manual dispatch; default setup is off. It is advisory, and on default setup
it analysed every pull-request push: four language jobs at a median of ten
minutes, competing with the required checks for hosted runners. The workflow
keeps default setup's languages (`actions`, `javascript-typescript`, `python`,
`rust`), default query suite and `/language:<name>` categories, so existing
alerts stay matched; Dependabot's monthly `github-actions` update maintains the
pinned action. The tradeoff is that a finding appears after its change lands on
`main` rather than as a pull-request annotation. Pull-request overlay
acceleration no longer applies. Re-enabling default setup while this workflow
exists makes its uploads fail, so remove the workflow first.

History privacy audits a pull-request head once, from `pull_request_target`.
The unprivileged requester no longer asks for a second audit of the same
commit on every branch push; it runs for `main`, tags and queue candidates
(see [the privacy checks](../.github/privacy/README.md)).

Lint project-service tuning, full-suite coverage cadence and further baseline
reductions need their own measurements. Multi-threaded lint is not an option
on hosted runners: one type-aware ESLint process peaks near 6 GB, and each
thread builds its own program. No deployment or database migration is part of
this update.
