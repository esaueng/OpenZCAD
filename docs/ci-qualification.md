# Fast PR checks and complete qualification

The staged `fleet-ci-v8.yml` supersedes v7, separates lint and typecheck, partitions root
unit tests over two runners, and combines the critical unit manifest with
Vitest's affected-file inventory from the full project. Changed tests are
eligible even when they are absent from the smoke manifest. Missing Git
history, failed discovery and invalid inventories select the complete
project. Individual test deadlines, isolation and per-runner worker limits
remain unchanged.

Unknown inputs, deleted files, dependency/configuration changes and kernel
updates select full unit suites. The browser gate runs critical journeys plus
changed regression files. Scheduled qualification, manual dispatch, `ci:full`
requests and browser regression deletions select the full browser matrix.
Changed browser regression files run every case, including untagged cases;
the other browser files retain their smoke tags. Exact STEP parity, builds,
bundle budgets and the existing privacy/security gates remain required.
The `ci:full` label takes effect on the next push. To request full validation
immediately, manually dispatch `ci` on the PR branch; a rerun retains its
original event payload. Unit selection
and timing artifacts identify the files executed by each partition.

An additive edit to `test/unit-ci-files.json` keeps critical plus affected
selection only when both valid manifests retain every previous entry. Removals,
replacements, malformed manifests and missing baselines still require complete
units. Package assets loaded outside the import graph also require complete
units. The dependency-audit workflow, its selector and tool installer have
dedicated tests in the critical manifest; other unknown scripts/workflows
remain broad inputs. CSS class coverage stays critical.

The v8 preflight runs the kernel declaration before application jobs. It remains
inside required `checks / validate`, so activating v8 does not depend on a
branch-protection setting change. Failed, missing or canceled preflights cannot
start application jobs or satisfy the completion gates.

Ordinary merge candidates run the unit selection, build/parity and browser
five tagged history/save canaries against the combined tree. They are a bounded
selection, not all cases in those two files. Queue reports retain the source
run and failure context. Explicit full requests and
browser regression deletions run the full browser partitions. A skipped or failed selected set cannot satisfy
the completion gates. Prior PR success does not stand in for a combined-tree
browser check.

## Daily qualification

`daily-validation.yml` runs at 07:37 UTC, on manual dispatch, and when its own
implementation changes in a PR. It executes complete root and web suites
with coverage and all six full browser partitions. Each full browser case has
one attempt, exposing flakes and avoiding repeated deadlines for persistent
failures. Browser artifacts include the report and failure-context files.
All jobs use the event's
immutable checkout SHA and read-only credentials. Failures retain reports;
the aggregate receipt records the source SHA, each project result and the
last successful scheduled main qualification. Missing, skipped or cancelled
projects do not produce a green receipt.

The repository maintainer owns failed qualification runs. Triage the failing
test and source SHA from the retained reports, distinguish product failures
from harness/resource failures, and promote a confirmed regression into the
critical or affected PR coverage. A red full run remains red. Do not relax
geometry, privacy, persistence or timeout assertions to clear it.

## Activation

The staging PR leaves `ci.yml` and `fleet-ci-v6.yml` unchanged. After it lands:

1. Retain the inline kernel declaration and all six existing required contexts
   and their GitHub App bindings. Requiring the separate declaration is an
   optional settings change; it must be verified before removing inline enforcement.
2. Activate v8 at the staging squash commit reachable from main, following
   [runner routing](runner-routing.md). Verify the new version on that PR's
   exact head and separate merge candidate before retiring v6.
3. Keep label events until the separate declaration is required. Any later
   trigger change must document when `ci:full` takes effect and update policy
   tests with it.

Compare PR and merge-candidate P50/P95 latency, summed runner-minutes and
daily-only regressions before reducing the critical manifest or shard count
further. The existing explicit full commands and manual desktop qualification
remain available. No deployment or migration is part of qualification.
