# H02 PR #805 M5 Pro qualification (2026-10-21)

H02 remains **Partial**. [PR #805](https://github.com/esaueng/OpenZCAD/pull/805) resolves the observed publication differences on this private trace, but fails the unchanged ≥20% exact-completion timing target and fixed Text restore assertion. Its UI session also does not exercise required checkpoint retirement or replay-budget recycling. Quiet-host, whole-worker retention and detached Text acceptance remain open.

## Frozen identities and environment

All six browser timing arms and the original sustained run use clean OpenZCAD candidate `d30b589edbf4bc4614fde84373ce9b07d6e85fec`, frozen paired Remus `0d942168550b6dd5101d049f7a10de0230bb5848`. The [previous campaign](h02-m5-pro-qualification.md) remains evidence for baseline `6cd0838b45ad9af18367b3d819de3b113cfcb246`; its samples and failures are preserved separately. No baseline or Linux sample is included here. Isolated checkouts preserve existing work.

The continuation helper is `207366427059804505d2920d49096f042939440e`. It changes only the opt-in test: missing retirement/recycling assertions retain their exact conditions and thresholds as soft failures, so independent lifecycle observations finish and the CLI still fails. Application/package source and dependency files are identical to `d30b589e`. No acceptance comparison, cache budget, geometry tolerance or pin is relaxed.

Environment: Apple M5 Pro, 15 logical CPUs, 48 GiB RAM; macOS 27.0.1; Node 22.23.1; Playwright 1.63.0; headless Chromium 153.0.8010.12, 1280 × 720 viewport, scale 1, ANGLE/Vulkan SwiftShader. AC is attached throughout the six arms. Browser plugin unavailable; the repository Playwright production-preview workflow is used. This is browser evidence, not desktop/WKWebView qualification.

The instruction to continue with recorded background load is retained. One-minute arm-start load is **4.34–23.58**, and before/after snapshots reach **32.34**. No independent validation/build suite or hook audit overlaps the timing campaign. Arms run serially with fresh preview servers and fixed 30-second pauses. This is loaded-host characterization and does not establish quiet-host acceptance. A separate worktree install/hook audit overlaps the tail of the first sustained run, after timing has finished; its load is part of the private observations.

Private source bytes are checked before/after every timing arm and both sessions. The existing input is unchanged. Input names/fingerprints, generated documents, logs, samples, browser error contexts and all raw evidence remain outside Git.

## All six matched arms, including failures

The source, candidate commit, lockfile, 31-feature recipe, `holder_height` sequence, pair identities and final 17-body / 720-face counts match. Samples are retained before budget assertions, including all three enabled failures. The unchanged aggregator accepts all three pairs; no slow sample is excluded.

| Pair  | Order              | Disabled exact, ms | Enabled exact, ms | Arm assertions (disabled / enabled) |
| ----- | ------------------ | -----------------: | ----------------: | ----------------------------------- |
| 805-1 | disabled → enabled |            3,284.9 |           3,398.8 | pass / fail (Text restore)          |
| 805-2 | enabled → disabled |            3,264.3 |           3,639.0 | pass / fail (Text restore)          |
| 805-3 | disabled → enabled |            3,966.6 |           3,420.3 | pass / fail (Text restore)          |

All disabled arms exit 0. All enabled arms exit 1 because the first settled edit replays Text instead of restoring the fixed import. The two latency budget inequalities pass in every arm; the Text requirement still fails. The disabled arm sets only the existing adapter cache budgets to zero; enabled keeps production defaults. The worker document memo is active in both.

| First settled edit, ms    | Disabled median / p95 | Enabled median / p95 |
| ------------------------- | --------------------: | -------------------: |
| Suffix replay             |       978.4 / 1,164.1 |    1,056.3 / 1,101.4 |
| Growing-holder union      |         385.9 / 444.8 |        442.8 / 488.5 |
| Fixed Text                |           37.1 / 37.6 |          25.8 / 27.2 |
| Text placement            |             4.9 / 5.5 |            5.3 / 5.4 |
| Body measurement envelope |         910.7 / 980.4 |        973.7 / 973.9 |
| Exact completion          |     3,284.9 / 3,966.6 |    3,420.3 / 3,639.0 |

Nearest-rank p95 is the maximum of three samples. Exact-completion p95 improves **8.3%** (3,966.6 → 3,639.0 ms), below the unchanged **20%** target; enabled median is higher (3,284.9 → 3,420.3 ms). The aggregator reports `existingCacheTimingTargetMet: false` and `proposedBranchCacheAccepted: false`. These loaded samples do not measure an isolated causal cost relative to the previous baseline campaign.

Union, Text and placement are contained within replay; the measurement envelope accounts for overlapping timers. These stages are not added together. Preview-install median / p95 is **17.3 / 17.4 ms** disabled and **14.9 / 16.1 ms** enabled. That is installation duration, separate from input-to-preview and exact completion.

Both modes' six first-edit cache events are full rebuilds: all 31 features replayed, zero restored, all 17 bodies measured, zero reused, 102 `no-entry` misses and no integrity-reset reason. The candidate's conservative fresh-arena fallback on unsupported mode transitions is consistent with this observed loss of reuse. The unchanged one-edit eager oracle below still exercises actual reuse. Median stored local-copy JSON is 59,414,932 bytes in both modes; derived JSON size is not canonical-input equivalence.

## Endpoint memory observations

All six optional forced-GC geometry-worker probes succeed. Each metric is separate and all whole-worker retained-byte values remain unavailable (`null`).

| Bytes               |   Disabled median / p95 |    Enabled median / p95 |
| ------------------- | ----------------------: | ----------------------: |
| JS isolate heap     | 15,858,284 / 15,860,472 | 20,883,036 / 20,883,152 |
| CDP embedder heap   |         43,328 / 43,328 |         43,336 / 43,336 |
| CDP backing storage | 37,918,434 / 37,918,434 | 50,909,513 / 50,911,396 |

Maximum accounted measurement bytes are 0 / 16,364,243; maximum reported checkpoint/topology estimates are 7,403,328 / 60,929,796; maximum WASM linear-memory capacities are 130,023,424 / 203,882,496 (disabled / enabled). Accounting, estimates, capacity and CDP metrics overlap and are not summed. They do not establish a whole-worker retained-memory bound. The proposed 8 MiB allowance applies to an additional detached branch record, not total caches or the enabled-minus-disabled JS heap delta.

## Private exactness and lifetime

The unchanged private one-edit oracle and seven selected mutation/lifetime suites pass **93 tests**. All **3,204,155 serialized B-rep bytes** match across 17 bodies, including consumed construction bodies, and normalized publication matches across 720 faces. Its unchanged-source measurement hit compares full published buffer bytes/structure. The edited eager oracle restores 16 features, replays 12 plus three prepared features, and reuses 10 measurements while measuring seven. The unchanged strict public eager-to-idle reproduction also passes.

Publication retains the existing normalization: omit `updatedAt`, compare cross-arena mesh kind/triangle count, and zero only recognized-opening `faceA`/`faceB` diagnostic arena indices. Raw B-rep comparison separately compares every serialized byte. No topology references, lineage diagnostics, validation warnings or provenance fields are removed to obtain equality. Per-body serialization does not establish cross-body shared topology.

The original unmodified `d30b589e` browser probe completes 80 edits. Initial and all four 20-edit checkpoints match raw B-rep and publication with 17 bodies / 720 faces and zero warnings. It then exits 1 at the unchanged replay-budget coverage assertion, before recovery/restart. It records zero replay-budget recycles and zero observed checkpoint retirements. All four private pressure comparisons complete and pass before that stop.

The separate continuation repeats all 80 edits and completes seven fresh-oracle comparisons: initial, after 20/40/60/80 edits, after refusal recovery, and after actual worker restart. **Every raw and publication comparison matches**, with no page errors and unchanged source bytes. It exits **1**, records **two acceptance failures**, and reports `accepted: false`: required replay-budget recycling and checkpoint retirement remain unexercised. There are 161 observed main-adapter arena creations after 80 edits and 163 after recovery, with 161 worker-memo key removals before restart. Fresh-arena replacement does not substitute for cache-hit safety after retirement.

The main session keeps production 32-checkpoint, 128 MiB measurement and 8-entry / 32 MiB worker-memo limits; owner identities and byte sums agree. A separate private pressure adapter uses a calibrated **9,280,487-byte test cap**, admitting every individual entry while excluding the complete working set. This forces real eviction without changing production defaults or the proposed branch allowance:

| Pass | Evicted bodies remeasured | Retained hits | Accounted bytes | Raw / publication |
| ---- | ------------------------: | ------------: | --------------: | ----------------- |
| 1    |                         7 |            10 |       8,337,384 | match / match     |
| 2    |                        10 |             7 |       7,808,593 | match / match     |
| 3    |                         7 |            10 |       8,337,384 | match / match     |
| 4    |                        10 |             7 |       7,808,593 | match / match     |

The negative height edit is refused without changing the committed value. The following valid edit completes a newer fresh live version and matches the fresh oracle. IndexedDB confirms the local durable value before termination. Explicit termination removes the original geometry-worker target; reload creates a new target and a new arena, with zero restored features and zero reused measurements on its first sync and fresh-oracle equality. The two coverage failures remain failures despite these independent successful observations.

## Sustained post-GC observations

Fresh/pressure adapters are disposed, captured arrays and held documents released, and worker GC forced before each sample. Retired kernel diagnostics hold only weak references. These are instrumented-worker observations; temporary oracle work can raise WASM high-water capacity.

| Phase    | JS isolate heap, bytes | Embedder heap, bytes | Backing storage, bytes |
| -------- | ---------------------: | -------------------: | ---------------------: |
| initial  |             21,450,692 |               42,088 |             42,495,606 |
| block-1  |             26,495,820 |               42,088 |             54,891,923 |
| block-2  |             26,716,388 |               42,088 |             54,911,507 |
| block-3  |             26,755,564 |               42,088 |             54,928,274 |
| block-4  |             26,908,232 |               42,088 |             54,936,995 |
| recovery |             26,908,884 |               42,088 |             54,944,915 |
| restart  |             21,583,268 |               42,088 |             42,591,942 |

No whole-worker/process/GPU retained total or accepted retained-memory ceiling is established. Fresh-arena replacement makes the required retained-checkpoint lifetime coverage unavailable in this trace. The private manifest retains both attempts, every failing/slow arm, source verification and immutable helper identities. Neither attempt is relabelled as accepted.

## Verification and remaining gates

Required local checks run serially after both browser sessions stop, on clean verification head `7b454f0ff85bc2076fd968f6968b7c50bedf46d6`:

| Command                   | Result |
| ------------------------- | ------ |
| `pnpm lint`               | pass   |
| `pnpm typecheck`          | pass   |
| `pnpm test`               | pass   |
| `pnpm test:parity-corpus` | pass   |
| `pnpm build`              | pass   |

The initial full test attempt on `20736642` retains eight failures: dummy filesystem fixtures used macOS `/var` aliases while the unchanged guard correctly returned canonical `/private/var` paths. The verification head canonicalizes only the dummy fixture directory with `realpathSync`; all 28 existing artifact-path regressions pass. No private path or guard is changed. The original failed log is preserved. Lint passes with zero errors and 17 existing warnings; the full test retry passes 5,809 root tests (8 existing skips) and 3,474 web tests. Parity passes 220 tests with one existing skip. The full build passes paired-WASM byte/provenance and bundle checks. Hosted check state is reported separately in the PR. Public CI has private inputs unset and cannot replace these private acceptance results. The continuation's opt-in probe is deliberately red when required lifetime coverage is absent. Reproduce with the [matched-arm commands](../2026-10-15/h02-matched-cache-benchmark.md#reproduction) and [sustained command](h02-m5-pro-qualification.md#reproduction-and-verification), using fresh outside-repository output paths and pair IDs.

The candidate still needs the ≥20% p95 target, fixed Text restore, quiet-host timing, private retained-checkpoint/recycling coverage and whole-worker memory acceptance. The detached Text branch additionally requires complete dependency/effect analysis, zero false hits across all mutation cases and a branch-preserving pinned kernel contract; unknown dependencies must miss. Existing-cache output equality does not qualify that unimplemented branch. H02 stays Partial. No paid Apple Silicon workflow, merge, manual deployment or migration is performed.
