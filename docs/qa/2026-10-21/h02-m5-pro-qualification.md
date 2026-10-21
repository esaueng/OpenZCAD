# H02 M5 Pro existing-cache qualification (2026-10-21)

H02 remains **Partial**. This continues the local qualification handoff in [PR #799](https://github.com/esaueng/OpenZCAD/pull/799) and its [M5 Pro handoff](h02-existing-cache-qualification.md#local-m5-pro-handoff). Existing-cache timing does not qualify the proposed detached Text cache. Runtime behavior, dependency pins, cache defaults, validation, tolerances and acceptance thresholds are unchanged.

## Immutable inputs and environment

The browser timing checkout is clean at OpenZCAD `6cd0838b45ad9af18367b3d819de3b113cfcb246`, with frozen paired Remus `0d942168550b6dd5101d049f7a10de0230bb5848`. The oracle is PR #799’s unchanged test at `ec3360477a73095099fa24c77b344b3875848d06`. Separate isolated checkouts preserve existing work. Application/package source trees and the lockfile are unchanged. Private source bytes were checked before and after every arm; the source, its name/fingerprint, generated backups, raw samples, logs and browser artifacts remain outside the repository.

Environment: Apple M5 Pro, 15 logical CPUs, 48 GiB RAM, macOS 27.0.1, Node 22.23.1, Playwright 1.63.0, headless Chromium 153.0.8010.12, 1280 × 720 viewport, device scale 1. The renderer reports ANGLE/Vulkan SwiftShader. This is a production-preview browser campaign, not physical-display, WKWebView or desktop distribution acceptance. AC power was attached.

Background work continued with its load recorded. One-minute arm-start load ranges from **10.62 to 26.82**; before/after snapshots range up to **37.02**. No independent local build or validation test suite ran alongside retained timing samples. A required Git-hook audit overlapped the early arms; its work is part of the recorded background load. Arms ran serially with fresh preview servers and a fixed 30-second pause between arms. This is **loaded target-hardware characterization**, and does not close quiet-host acceptance. Linux samples are not included.

## All six matched arms

The source, source commit, lockfile, 31-feature recipe, `holder_height` sequence, pair IDs, observed cache modes and final exact counts match. Every arm passes the unchanged settled/immediate-reload budgets. No failure or slow sample was removed. Disabled sets the existing history, measurement and STEP-import cache budgets to zero; enabled keeps defaults. The worker’s document-keyed memo remains active in both arms.

| Pair | Order              | Disabled exact completion, ms | Enabled exact completion, ms | Budgets     |
| ---- | ------------------ | ----------------------------: | ---------------------------: | ----------- |
| 1    | disabled → enabled |                       4,784.0 |                      2,938.0 | pass / pass |
| 2    | enabled → disabled |                       4,737.4 |                      2,584.5 | pass / pass |
| 3    | disabled → enabled |                       4,554.2 |                      2,679.0 | pass / pass |

Times below are milliseconds. With three samples, nearest-rank p95 is the maximum. Union, Text and placement are contained within replay. Measurement is the envelope of overlapping timers. These stage rows are not added to Enter-to-fresh-live exact completion. The first-edit preview-install measure is separate: disabled median / p95 **15.2 / 17.9 ms**, enabled **14.8 / 16.2 ms**. This named installation measure is not Enter-to-preview or exact completion.

| Observation                     | Disabled median / p95 | Enabled median / p95 |
| ------------------------------- | --------------------: | -------------------: |
| Suffix replay                   |     1,515.7 / 1,587.3 |    1,065.3 / 1,194.8 |
| Growing-holder union            |         664.5 / 728.1 |        474.1 / 522.4 |
| Fixed Text branch               |            0.0 / 56.5 |            0.0 / 0.0 |
| Parameter-driven text placement |             6.1 / 6.3 |            5.4 / 7.5 |
| Body measurement envelope       |     1,189.6 / 1,214.9 |    1,110.7 / 1,137.2 |
| Total exact completion          |     4,737.4 / 4,784.0 |    2,679.0 / 2,938.0 |

Observed p95 exact completion is **38.6% lower** (4,784.0 → 2,938.0 ms). The unchanged ≥20% existing-cache timing target is met for this three-pair loaded-host sample. `proposedBranchCacheAccepted` remains false. Zero Text replay in enabled runs is existing prefix reuse, not a detached branch hit.

Across six first-edit cache events per arm, disabled restores/reuses zero, replays all 31 features, measures all 17 bodies, and reports 102 `no-entry` misses. Enabled medians are 13.5 replayed / 17.5 restored features and 7.5 measured / 9.5 reused bodies, with 45 `solid-handles` misses and 57 hits. Neither arm reports an integrity reset. All final exact counts are 17 bodies / 720 faces. Median stored local-copy JSON length is 59,414,932 bytes disabled / 59,527,314 enabled; derived snapshot size is not canonical-input or exact-output equivalence.

## Matched endpoint memory

All six optional CDP probes succeed after five edits and two durable reloads, with forced geometry-worker GC. The metrics remain separate; none is a total worker-memory measurement.

| Observation, bytes  |   Disabled median / p95 |    Enabled median / p95 |
| ------------------- | ----------------------: | ----------------------: |
| JS isolate heap     | 15,844,364 / 15,846,504 | 21,956,532 / 21,958,644 |
| CDP embedder heap   |         43,328 / 43,328 |         43,336 / 43,336 |
| CDP backing storage | 37,912,289 / 37,912,289 | 50,903,107 / 50,903,107 |

Maximum accounted measurement retention is 0 / 16,364,678 bytes; maximum estimated checkpoint/topology bytes are 7,403,328 / 141,467,197; maximum WASM linear-memory capacities are 130,023,424 / 273,743,872. Accounting, estimates, capacity and CDP observations can overlap. They are not summed, and enabled-minus-disabled heap is not tested against the proposed branch allowance. No detached record or additional 8 MiB allocation exists.

## Private oracle

The unchanged private oracle passes on this Mac: all **3,204,155 serialized B-rep bytes** match across 17 bodies, including consumed construction bodies. Normalized publication has zero differing root/body field paths across 720 faces. The unchanged-source measurement hit also compares the complete published buffer bytes and structure. Raw bytes come from the actual owning build before measurement; there is no second export-built model or numeric tolerance. Publication uses the same documented cross-arena normalization as PR #799. This does not establish cross-body shared-topology identity or equality of unrelated kernel state.

All **93 tests in eight selected oracle/mutation/lifetime suites** pass serially after the timing campaign: private holder, measurement safety, exact-arena equivalence, publication determinism, bounded history, incremental rebuilding, imported STEP caching and scope digests. The three new public probe-contract tests pass, including deliberate raw-byte corruption, rejected retired-checkpoint restoration and memo ownership/eviction.

## Sustained private session

The final instrumented production-preview session runs at qualification head `5e8ac0e8a0461652499ea1e42cdf19aeb0294d35`, whose application/package sources and lockfile still match the runtime pin. It performs **80 distinct height edits**, 2 normal replay-budget kernel recycles, suffix checkpoint retirement, private measurement-cache eviction, an invalid edit, recovery, durable local save, explicit geometry-worker termination and page reload into a different worker target. All inputs remain local and unchanged.

**The sustained publication-equivalence acceptance gate fails.** Raw B-rep equality holds at every captured checkpoint, but published face/edge references and lineage diagnostics differ from a cache-disabled fresh build under the same recorded analysis/lineage-demand options. The original normalization is unchanged: these fields are not removed or relaxed. Failure-collecting assertions let independent lifecycle/memory probes finish and still fail the run. The final CLI exit is 1; this is not a passing private qualification.

| Checkpoint | Raw B-rep | Normalized publication | Differing bodies / field paths |
| ---------- | --------- | ---------------------- | -----------------------------: |
| initial    | match     | match                  |                          0 / 0 |
| block-1    | match     | FAIL                   |                        4 / 277 |
| block-2    | match     | FAIL                   |                        5 / 351 |
| block-3    | match     | FAIL                   |                        5 / 351 |
| block-4    | match     | FAIL                   |                        4 / 277 |
| recovery   | match     | FAIL                   |                        4 / 277 |
| restart    | match     | match                  |                          0 / 0 |

Every checkpoint in the table has 17 bodies / 720 faces with zero warnings. The differing field families are `topology.faces[*].reference`, `topology.edges[*].reference` and `topology.lineageDiagnostics`. Raw geometry equivalence does not satisfy the separate published-lineage requirement. The one-edit Node oracle above remains a narrower passing case.

### Public reproduction of demand-history-dependent publication

The same class of publication mismatch reproduces without the private input on
two overlapping public boxes and their terminal union. Run the opt-in probe:

```bash
pnpm exec vitest run --config test/perf/h02-publication-history.config.ts
```

At the unchanged runtime and paired-kernel pins, a cold idle build matches a
fresh cache-disabled idle oracle. An eager build followed by an idle request
restores all three feature checkpoints and reuses all three measurements, but
its publication differs from that same fresh idle oracle. All **15,798 raw
B-rep bytes across three bodies / 20 faces** still match, with zero warnings.
The differing result body has 32 field paths: 22 edge references and 10 lineage
diagnostic paths. Aligning both requests to eager probing restores publication
equality; disposing the warm adapter and rebuilding idle does too.

This isolates a public cause of history-dependent publication. The current
adapter explicitly permits idle calls to restore checkpoints built with eager
boolean lineage probing, while a fresh idle build skips that probing. Parameter
preflight and subsequent live idle requests exercise this transition. It does
not establish that every private mismatch has no additional cause, or that extra
lineage is harmless: lineage reconciliation can withhold conflicting references.

The opt-in probe retains the strict publication-equality assertion and exits 1
for the reproduced mismatch. It is separate from ordinary passing CI, just as
the private sustained acceptance probe is. No comparison fields are dropped,
no demand is added to the private oracle to hide the difference, and the runtime
reuse policy is unchanged. Resolving publication determinism needs a runtime
change followed by fresh qualification; this frozen-runtime evidence does not
claim that repair or accept the detached Text proposal.

### Eviction, recovery and restart

The main session retains the existing default limits: at most 32 checkpoints, 128 MiB of accounted measurements, and the worker memo’s 8-entry / 32 MiB cap. Every observed live checkpoint owner agrees with its table and all accounted byte sums stay within their respective limits. The final pre-termination state reports 217 checkpoint retirements and 161 observed worker-memo key removals. Retired-checkpoint restoration is rejected wherever a retired checkpoint is available; the following exact comparisons retain the valid live geometry. This is sampled existing-cache lifetime evidence, not a detached-branch proof.

A separate adapter calibrates a real private working set, then uses an explicit **9,280,487-byte test cap** that admits each individual entry and cannot hold the full working set. This forces real LRU eviction; it does not change the main session’s production limits or allocate the proposed branch allowance. Four passes compare against fresh builds with matching body order:

| Pass | Evicted bodies remeasured | Retained hits | Accounted bytes | Raw / publication |
| ---- | ------------------------: | ------------: | --------------: | ----------------- |
| 1    |                         7 |            10 |       8,337,384 | match / match     |
| 2    |                        10 |             7 |       7,808,593 | match / match     |
| 3    |                         7 |            10 |       8,337,384 | match / match     |
| 4    |                        10 |             7 |       7,808,593 | match / match     |

The negative height edit is refused without changing the committed value. A subsequent valid edit completes a newer fresh live version and its raw geometry matches fresh. The local saved value is read directly from IndexedDB before termination. The old worker target disappears, the replacement starts with one new arena, zero retired checkpoints and an initial sync with zero restores/reuse, and its geometry is compared with a fresh oracle again. These observed lifecycle checks do not repair the earlier publication failures.

### All final-session post-GC observations

Oracle and pressure adapters are disposed, captured byte arrays and the held document are released, and GC is forced before each observation. Additional diagnostics do not retain a retired kernel: that reference is weak, and the extra document and captured bytes are released before GC. These are instrumented-session observations, not an uninstrumented production-memory bound. The temporary oracle work can raise WASM capacity; that capacity is a high-water observation, not retained heap.

| Phase    | JS isolate heap, bytes | Embedder heap, bytes | Backing storage, bytes |
| -------- | ---------------------: | -------------------: | ---------------------: |
| initial  |             21,372,308 |               42,088 |             42,486,889 |
| block-1  |             33,089,004 |               42,088 |             54,885,517 |
| block-2  |             30,552,724 |               42,088 |             54,905,101 |
| block-3  |             28,226,908 |               42,088 |             54,920,509 |
| block-4  |             34,821,192 |               42,088 |             54,930,589 |
| recovery |             35,407,896 |               42,088 |             54,938,509 |
| restart  |             21,512,044 |               42,088 |             42,583,225 |

These repeated observations include cache warm-up, kernel recycling, private pressure, recovery and restart. They are not a whole-worker/process/GPU memory measurement or an accepted total retained-memory bound. The proposed 8 MiB branch allowance is neither a total-cache limit nor an enabled-minus-disabled JS-heap threshold.

### Retained attempts

Every attempt remains outside the repository with its immutable helper head, raw records and browser error context. Earlier attempts are not discarded or relabelled as completed runs.

| Attempt | Helper head    | Completed edits | Retained outcome                                                                                                                                            |
| ------- | -------------- | --------------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1       | `39ae4ce8f8ca` |               0 | Playwright buffer-upload limit before private model load.                                                                                                   |
| 2       | `725ff3499484` |               0 | Five-second import-readiness wait before edits; subsequent helpers use the normal projection-free backup and existing 180-second exact-readiness allowance. |
| 3       | `04fd40e14f4c` |              20 | Publication mismatch after 20 edits; raw bytes match.                                                                                                       |
| 4       | `7aea055d2103` |              80 | Publication mismatches retained through 80 edits; pressure RPC exception before lifecycle completion.                                                       |
| 5       | `ee593f5fcb80` |              80 | 80 edits, real private eviction and refusal/recovery; stopped at an incorrect cloud-sync assertion for a local project.                                     |
| 6       | `5e8ac0e8a046` |              80 | All independent probes complete; run fails the unchanged publication-equivalence assertions.                                                                |

The local-project assertion was corrected to require local status plus actual durable IndexedDB data; no cloud upload is needed. All baseline failures, completed slow samples, setup logs and interrupted validation logs are retained privately. Local validation suites begin only after the private browser session has stopped.

## Acceptance boundaries

The [design acceptance gate](../../plans/h02-private-holder-cache-design.md#acceptance-benchmark-before-implementation) is unchanged. The pinned Remus restore API still permanently retires later checkpoints and cannot restore an old Text branch while preserving a newly rebuilt holder branch. A detached record still needs branch-preserving kernel support and complete interval dependency/effect analysis; unknown dependencies must miss. Timing from shipped caches cannot qualify an unimplemented record.

Quiet target-device timing, total-worker retained-memory bounds and the proposed branch’s complete mutation/lifetime/memory criteria remain separate requirements. H02 stays Partial while any requirement is unmet. No paid Apple Silicon workflow dispatch, merge, deployment or migration was performed.

## Reproduction and verification

Use the unchanged [matched-arm commands](../2026-10-15/h02-matched-cache-benchmark.md#reproduction), in the order disabled/enabled, enabled/disabled, disabled/enabled, with three new pair IDs and outside-repository output paths. The aggregator rejects mismatched source/lockfile/commit/sequence/counts, missing pairs and disabled-arm reuse.

For the additional session, use a clean committed qualification checkout and a fresh private output directory:

```bash
OZ_PERF=1 OZ_PERF_BUDGET=1 \
OZ_PERF_HOLDER_STEP=/absolute/local/source.step \
OZ_PERF_HOLDER_PARAMETER=holder_height \
H02_CACHE_MODE=enabled H02_SESSION_PROBE=1 H02_PAIR=session-1 \
OZ_PERF_OUT=/absolute/local/new-session/session.jsonl \
pnpm exec playwright test --config test/perf/h02-session.config.ts
```

Local lint passes with zero errors and 17 pre-existing warnings; typecheck passes on `5e8ac0e8a0461652499ea1e42cdf19aeb0294d35`. The three public probe-contract tests and the 93 selected private-oracle/lifetime tests pass. All six matched timing arms pass their existing budgets. The sustained private session completes its independent probes and exits 1 for the five publication-equivalence failures recorded above.

Required repository verification remains `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:parity-corpus` and `pnpm build`, plus the hosted Playwright aggregate and Cloudflare dry-run checks. The PR's current-head check runs provide the hosted evidence. Public CI runs with private inputs unset; its result does not replace the opt-in private acceptance outcome. No acceptance assertion, comparison field or numeric budget is weakened to obtain a green result.

Review follow-up strengthens the outside-repository artifact contract for future
runs. Samples, source-containing backups, browser artifacts and Vite build outputs
use one canonical-path guard rooted at the checkout, including when a command
runs from a package directory. Repository symlinks, cleanup destinations containing
the checkout, and artifact/sample overlaps fail closed. Backups use exclusive
creation with mode `0600`. Eleven public dummy-filesystem regressions cover these
cases without reading or writing the private input. This changes test-output
handling only; it does not change any recorded samples or acceptance condition.
