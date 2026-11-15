# CI runtime optimization

The runtime update stages `fleet-ci-v8.yml` without changing the active v6
caller. Follow the two-PR activation procedure in [runner routing](runner-routing.md).
The new callee retains the exact runner trust and isolation boundaries, adds a
kernel preflight to required validation, partitions root units over two runners,
separates lint and typecheck, and retains critical plus affected coverage.
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

## Staged v9: no serial preflight, lint on two runners

`fleet-ci-v9.yml` is staged, not active; it goes live through the same
two-PR procedure. It changes scheduling only. In v8 every check waits for the
hosted `plan` job, so a pull request pays for two runner waits before its
first test starts (a median of two minutes each under load, up to eight). In
v9 lint, typecheck, units, the build and the PR browser shards depend on queue
trust alone and each runs `scripts/ci-selection.mjs` itself. `plan` still runs
the kernel declaration and still chooses the queue and manual browser set, and
`validate` and `e2e` still fail unless it succeeds.

Lint is the longest single step (222 s hosted). v9 runs it as two partitions,
`apps` and `packages test types`, through `pnpm lint:paths`; each took 77 to
78 s locally against 158 s for the whole tree. ESLint's `--concurrency` was
rejected: one type-aware process peaks at 5.8 GB and every thread builds its
own program. `test/ci-staged-fleet.test.ts` holds the partitions to the paths
of `pnpm lint` and pins the workflow header, queue authorization, isolation
guard, runner expression and both gates to v8's bytes.

## Qualification and later work

Validate the staging PR and a separate activation PR on their exact heads.
Activation pins the new callee's landed main commit; it must also pass a
separate merge-group run. Compare PR and queue timing cohorts by kernel and
selection mode. A green PR run is not evidence that a queue candidate passed,
and no specific merge-time improvement is guaranteed before measurement.

CodeQL remains on default setup. A later language-routing migration must prove
that advanced setup retains compatible JS overlay acceleration, source/query
coverage, language-category annotations and update maintenance before changing
the scanner setting. The sampled Rust work is only a candidate gross saving;
CodeQL is advisory under the current required checks. Lint project-service
tuning, full-suite coverage cadence and further baseline reductions likewise
need their own measurements. No deployment or database migration is part of
this update.
