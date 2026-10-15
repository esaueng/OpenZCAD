# H02 matched cache-disabled/cache-enabled benchmark

This benchmark reuses `test/e2e/perf-holder-reload.spec.ts` against production
Vite preview. It measures the **existing** caches. No detached Text-branch
record is implemented, and runtime defaults and normal builds are unchanged.
The [design acceptance gate](../../plans/h02-private-holder-cache-design.md)
still applies to any proposed branch cache; a speedup from existing caching
cannot qualify a new record or its lifetime contract.

## Measurement setup

The requested macOS checkout is unavailable in this execution environment.
The benchmark uses the supplied isolated Linux OpenZCAD worktree refreshed to
main `0b07b506597b07bfc0c03b2a3da64e8d9bb77597`, with paired Remus
`1f8d2950c019a95d9bfb03aaea0d45afb51ab058`. The locally available holder STEP
is exercised without copying the source, documents, raw browser samples or
private identifiers into this repository. Results on this host do not replace
the historical M5 Pro measurements.

The test-only Vite configuration gives each arm a separate build directory
and aliases the exact-adapter factory through
`test/perf/h02-browser-exact.ts`. The enabled arm passes the existing defaults;
the disabled arm sets the existing history-checkpoint, measurement-payload and
STEP-import cache budgets to zero. Both retain identical validation,
recognition, preflight, publication and UI behavior. This comparison measures
the combined existing adapter caches; it does not isolate their individual
contributions or disable the worker's document-keyed result memo.

Each arm imports the same source, applies the same verified holder-and-text
recipe and performs the same parameter sequence, including durable reloads.
The first edit after settled reload is the primary comparison. Preflight and
fresh committed live completion are both required; preview time is separate.
The prepared campaign uses three serial matched pairs with alternating arm order (disabled/enabled,
enabled/disabled, disabled/enabled). No local validation suite runs concurrently
with retained timing samples. This is a small characterization on a shared
host, not an isolated tail-latency study. p95 is nearest rank and therefore the
maximum of three samples; slower completed samples remain included.

The source digest is retained from the exact buffer sent to the browser, before
the import. Replacing the STEP file during a run cannot relabel an earlier
import as the replacement; a regression exercises that file-change case.

Matched arms require a clean checkout, including staged and untracked source.
The runner pins the source commit and lockfile digest before building, checks
them before and after the build and at the start/end of each arm, and retains
that identity in the sample. A dirty or changed checkout refuses the sample.
Do not edit or switch the measured checkout while a campaign is running.

Raw samples identify the source/lockfile hashes, source commit, pair, parameter
sequence, observed worker cache mode, document bytes, body/face counts, stages
and per-edit cache events. The running disabled arm must restore zero features
and reuse zero measurements. A fresh preview server is mandatory for every arm
to prevent accidentally measuring an earlier build. Completed samples are
written before budget assertions, so budget failures retain their evidence.

The probe's successful commit assertion now accepts the UI's appended live
rebuild-progress suffix. It still requires the successful parameter-update
message, exact preflight and a newer fresh live version. The original exact
whole-text match timed out after successful commit because that readout now
includes progress and then clears; the failed exploratory run produced no
completed timing sample and is not part of the comparison.

## Results and remaining blocker

**H02 remains Partial; the branch-cache acceptance gate is not met.** The
comparison tooling is ready, but this host did not produce a completed matched
browser pair. No median/p95 or 20% speedup is claimed from incomplete runs.

Environment: Linux x86-64, AMD Ryzen 9 5900XT (32 logical CPUs), 31 GiB RAM,
Node 24.14.0, Playwright 1.63.0 / Chromium 153.0.8010.12, headless production
preview. During the corrected disabled-arm run, a host process snapshot showed
load averages **150.53 / 79.90 / 36.57**, concurrent unrelated geometry tests
and Rust compilation, 19 GiB used RAM and 7.9 GiB used swap. The runner was
still doing exact work. Its own Playwright process was interrupted after
5.5 minutes; the serial campaign exited 130 before starting the enabled arm.
Unrelated jobs were preserved. The earlier exploratory run failed the obsolete
whole-readout assertion after 3.4 minutes. Neither is a complete timing sample.
The requested macOS checkout and its named hardware remain unavailable here.

| Required observation                    | Disabled            | Enabled      |
| --------------------------------------- | ------------------- | ------------ |
| Completed matched first-edit samples    | 0                   | 0            |
| Suffix replay median / p95              | unavailable         | unavailable  |
| Growing-holder union median / p95       | unavailable         | unavailable  |
| Fixed Text branch median / p95          | unavailable         | unavailable  |
| Parameter-driven placement median / p95 | unavailable         | unavailable  |
| Body-measurement envelope median / p95  | unavailable         | unavailable  |
| Total exact completion median / p95     | unavailable         | unavailable  |
| Browser hit/miss counts and retention   | no completed sample | not run      |
| Post-GC browser-worker JS heap          | not measured        | not measured |

The separate current-pin exact-publication oracle passed before the host-load
spike: **17 bodies, 720 faces, zero differing root or body field paths**.
Its reopened embedded-source document is **68,820,487 bytes**; this is not a
browser reference-form document-size measurement. The first edit restored
16 features and replayed 15, measured nine bodies and reused eight. All nine
measurement misses were `solid-handles`; the event was `prefix-restore`, with
no integrity reset. The source-only unchanged measurement hit passed the full
buffer-byte/structure assertion. Measurement hits remain guarded by complete
live-handle/validation witnesses and provenance; their count alone is not an
independent proof of the proposed Text-branch key.

That oracle event retained **16,358,040 accounted measurement bytes**,
reported **69,194,634 estimated checkpoint/topology bytes**, and a
**152,043,520-byte WASM linear-memory capacity**. These are one Node oracle's
adapter/kernel counters, not browser retained heap or matched memory deltas.
They are not used to claim compliance with the design's extra 8 MiB branch cap.

A quiet serial run on the target machine, using the same local source and the
commands below, is the immediate blocker to filling the timing and browser
memory table. The summary script deliberately refuses empty/missing arms.
Even after that run, the proposed branch cache still needs its independent
branch-preserving lifetime contract, complete mutation and long-session
qualification, raw exact/B-rep equivalence and incremental acceptance evidence.

## Stage accounting

Suffix replay uses the worker's `history` duration. Growing-holder union,
fixed Text import and parameter-driven text placement are contained within
replay and are reported separately, never added again to completion time.
The union is identified by its recipe construction-feature prefix rather than
a hardcoded private body name.

In the current staged pipeline, even the outer per-body measurement timers
can overlap: they stay open until deferred analysis finishes. The report uses
the envelope of the outer measurement intervals reconstructed from console
receipt times and their worker durations. This includes intervening scheduling
and console-delivery uncertainty; it is not the sum of overlapping body or
nested subtask timers. Enter-to-fresh-live exact completion remains the primary
acceptance timing and does not use this reconstructed envelope.

## Exact-output and lifetime evidence

The existing opt-in private-holder oracle is rerun with all three cache budgets
zero in its fresh oracle. Its unchanged-source check compares the complete
published payload, including mesh buffer bytes, exactly. Its first-edit
comparison covers all published validation, warnings, topology/lineage and
measurement provenance under the established cross-arena normalization:
timestamp and two arena-local opening diagnostic indices are normalized;
mesh arrays are represented by triangle counts. This is structural publication
equivalence, not byte-identical remeshing or serialized raw B-rep equivalence.
The historical failing fields are retained in the assertion.

A benchmark cannot establish zero false hits for an unimplemented Text-branch
cache. Its parameter/sketch/unit/source/order/suppression/restart mutation
matrix, branch-preserving kernel restoration, unknown-dependency misses and
long-session eviction/refusal/termination qualification remain required before
that cache can be accepted. Existing measurement and prefix-cache tests are
separate evidence and do not establish that proposed contract.

An optional Chromium CDP probe attaches to the same browser context's geometry
worker after all timed edits, forces GC and records `Runtime.getHeapUsage`.
When attachment or that API is unavailable, the sample records `null`.
Post-GC isolate JS heap, embedder heap and backing-storage observations are
separate from total worker, WASM, GPU or process memory. Accounted
measurement/checkpoint bytes and WASM linear-memory capacity cannot substitute
for total retained heap or establish the proposed branch-memory bound.
Branch-record retention remains zero; no new 8 MiB allowance is allocated.

## Reproduction

Keep all output outside the repository and use a fresh output directory for
each benchmark campaign. Run each arm serially, reversing order on alternate
pairs. Set `H02_PAIR` to the same unique ID for the two matched arms:

```bash
OZ_PERF=1 OZ_PERF_BUDGET=1 \
OZ_PERF_HOLDER_STEP=/absolute/local/source.step \
OZ_PERF_HOLDER_PARAMETER=holder_height \
OZ_PERF_BUILD=h02-matched H02_PAIR=1 H02_CACHE_MODE=disabled \
OZ_PERF_OUT=/absolute/local/h02/disabled.jsonl \
pnpm exec playwright test --config test/perf/h02-browser.config.ts
```

Repeat with `H02_CACHE_MODE=enabled` and a separate `enabled.jsonl`; repeat both
arms for pair IDs 2 and 3. Both use the same working tree and frozen install.
The benchmark configuration requires a real local STEP and refuses a missing
source, invalid mode or repository-local output instead of succeeding with
zero private tests.

```bash
node scripts/h02-cache-benchmark.mjs \
  /absolute/local/h02/disabled.jsonl /absolute/local/h02/enabled.jsonl \
  > /absolute/local/h02/summary.json

OZ_PERF_HOLDER_STEP=/absolute/local/source.step \
OZ_PERF_PRIVATE_DIFF_OUT=/absolute/local/h02/oracle.json \
pnpm exec vitest run test/h02-private-holder-cache.test.ts

node --test scripts/h02-cache-benchmark.test.mjs
```

The report rejects mismatched source, lockfile, commit, scenario, feature
count, exact body/face counts, edit sequence, duplicate/missing pairs, inactive
mode instrumentation and any disabled-arm cache reuse. It requires at least
three completed matched pairs before reporting the existing-cache timing target
as met and always leaves proposed-branch acceptance false.

## Verification scope

- Frozen dependency install: passed; manifests and lockfile unchanged.
- Lint: passed, zero errors and 16 existing React-hook warnings.
- Typecheck: passed.
- `pnpm build`: passed, including paired-WASM verification, bundle limits and
  provenance, with `OPENZCAD_BUILD_COMMIT` explicitly set to the inspected
  source commit. An earlier concurrent-output conflict was resolved by giving
  each benchmark arm its own build directory; the standard build was rerun.
- Final public-fixture smoke: both browser arms passed the full import,
  verified recipe, committed edits, durable reloads and fresh exact-readiness
  flow. The aggregator accepted the matched source/pair/edit identity and
  counted eight bodies / 118 faces. Disabled syncs restored/reused zero;
  its two first-edit events recorded 16 `no-entry` misses. Enabled events
  recorded six `solid-handles` misses and validated measurement reuse.
  Post-GC geometry-worker JS heap was 5,953,064 bytes disabled and
  6,735,932 bytes enabled (one end-of-session observation per arm). This tiny
  public fixture has no Text branch and does not fill the private table or
  qualify the branch cache. Its raw samples stay outside the repository.
- Focused H02 checks: 27 passed across measurement-cache safety, publication
  determinism, the private oracle and the report-contract wrapper. The initial
  report-wrapper attempt was blocked by sandbox subprocess permission; rerun
  with that permission passed. The ten Node report tests also exercise nearest-rank
  p95, overlapping timers, exact 20% threshold, zero-baseline refusal, pair/input
  mismatches, body/face-count mismatches, union-only cache hits and refusal to
  accept a one-pair smoke run as the timing target.
- Private production campaign: no completed matched samples; interrupted under
  unrelated host contention as described above.
- Browser plugin unavailable; browser checks use the repository's Playwright
  workflow. No new browser or system packages were installed.

Full root/web suites, the parity corpus and the full six-shard E2E matrix have
not been rerun locally for this benchmark-only change. Hosted PR gates remain
separate from focused local checks. No merge, deployment, migration or Apple
Silicon workflow dispatch is part of this work.
