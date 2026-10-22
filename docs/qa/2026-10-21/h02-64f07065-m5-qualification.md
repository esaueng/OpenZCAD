# H02 PR #805 M5 Pro follow-up at `64f07065` (2026-10-21)

H02 remains **Partial**. The [PR #805 candidate](h02-lineage-runtime-candidate.md) passes the unchanged fixed Text-restore assertion and ≥20% p95 exact-completion target on this recorded-load M5 Pro campaign. The unchanged private 80-edit session passes exactness, eviction, replay-budget recycling, checkpoint retirement, refusal/recovery and actual worker restart. Quiet-host timing, whole-worker retained-memory acceptance and the proposed detached Text branch remain open.

## Frozen source and environment

Every retained browser sample, private oracle and local repository gate uses clean committed OpenZCAD **`64f0706512425b41bbf69f12dd4399b2cc93c274`** with frozen paired Remus **`0d942168550b6dd5101d049f7a10de0230bb5848`**. Application/package source matches runtime fix `aeacb511`; this evidence follow-up changes documentation only. The historical browser baseline stays **`6cd0838b45ad9af18367b3d819de3b113cfcb246`**. The [baseline campaign](h02-m5-pro-qualification.md), [failed first candidate](h02-pr805-m5-pro-qualification.md) and Linux observations remain separate; no such sample enters this aggregation.

The requested head was fetched into fresh isolated session and timing checkouts. Earlier work and historical qualification artifacts are preserved. Frozen installs retain the lockfile and paired WASM bytes. The matched harness, aggregator, sustained probe, private oracle and session instrumentation are byte-identical to the previously recorded qualification helpers; no source input, dependency pin, runtime behavior, default, budget, tolerance or acceptance threshold changes for these runs. Source bytes and clean HEAD are checked before and after execution.

Environment: Apple M5 Pro, 15 logical CPUs, 48 GiB RAM; macOS 27.0.1 (26A434); Node 22.23.1; pnpm 10.8.0; Playwright 1.63.0; headless Chromium 153.0.8010.12, 1280 × 720 viewport, scale 1, ANGLE/Vulkan SwiftShader. Browser plugin unavailable; the repository Playwright production-preview workflow is used. This does not qualify the desktop/WKWebView shell.

AC is attached throughout the six arms. Per the instruction to continue with recorded background load, arm-start one-minute load ranges **4.92–7.70**, and before/after observations reach **10.49**. `pmset` reports no recorded thermal or performance warning and no CPU power-status record. This is loaded-host characterization; quiet-host acceptance is not established. The sustained session runs first as the candidate record requires. All six timing arms then run serially, with a fresh preview server per arm and fixed 30-second pauses. No independent build, test suite, install or hook audit overlaps either browser campaign.

All private input names/fingerprints, documents, backups, logs, samples and browser artifacts remain outside Git. The existing input is unchanged. No failed or slow sample is removed.

## Three matched pairs

The unchanged aggregator verifies source commit, lockfile, source bytes, observed cache mode, pair identities, edit sequence, 31-feature recipe and final 17-body / 720-face counts. The edited parameter remains `holder_height`.

| Pair      | Order              | Disabled exact, ms | Enabled exact, ms | Assertions (disabled / enabled) |
| --------- | ------------------ | -----------------: | ----------------: | ------------------------------- |
| 805-64f-1 | disabled → enabled |            3,265.0 |           2,337.0 | pass / pass                     |
| 805-64f-2 | enabled → disabled |            3,251.1 |           2,487.1 | pass / pass                     |
| 805-64f-3 | disabled → enabled |            3,442.9 |           2,270.4 | pass / pass                     |

All six arms exit 0. Every enabled first settled edit has **zero Text executions**, retaining the existing fixed prefix. The two original within-run latency inequalities also pass. Disabled sets only the existing history, measurement and STEP-import cache budgets to zero; enabled keeps production defaults. The worker document-keyed memo remains enabled in both modes.

| First settled edit, ms    | Disabled median / p95 | Enabled median / p95 |
| ------------------------- | --------------------: | -------------------: |
| Suffix replay             |         959.9 / 962.1 |        902.4 / 918.5 |
| Growing-holder union      |         369.4 / 370.9 |        363.1 / 381.8 |
| Fixed Text                |           37.0 / 37.4 |            0.0 / 0.0 |
| Text placement            |             4.7 / 4.8 |            4.8 / 5.1 |
| Body measurement envelope |         876.2 / 883.1 |        862.7 / 867.6 |
| Exact completion          |     3,265.0 / 3,442.9 |    2,337.0 / 2,487.1 |

Nearest-rank p95 is the maximum of three samples. The unchanged aggregator reports **27.8%** lower p95 exact completion (**3,442.9 → 2,487.1 ms**), exceeding the unchanged **20%** target; median is **3,265.0 → 2,337.0 ms**. `existingCacheTimingTargetMet` is **true** for these three matched pairs and `proposedBranchCacheAccepted` remains **false**. These loaded samples do not establish quiet-host acceptance or an isolated causal comparison with an earlier runtime campaign.

Union, Text and placement timers are contained in replay; the body-measurement row is an envelope of overlapping timers. They are not summed into Enter-to-fresh-live exact completion. Preview-install median / p95 is **17.1 / 17.1 ms** disabled and **16.5 / 17.4 ms** enabled. This is installation duration, separate from input-to-preview and exact completion.

Across the six first-edit preflight/live cache events per mode, disabled replays all 31 features and measures all 17 bodies each time: zero restores/reuse, 102 `no-entry` misses and zero hits. Each enabled first edit restores 4 then 31 features, replays 27 then 0, measures 15 then 5 bodies, and reuses 2 then 12 measurements. Across its six events that is 42 hits, 45 `solid-handles` misses and 15 `provenance` misses; publication mode can require remeasurement under the unchanged provenance key. Enabled event medians / p95 are 13.5 / 27 replayed, 17.5 / 31 restored, 10 / 15 measured and 7 / 12 reused. Both modes report no integrity reset. These are existing prefix hits, not detached Text-branch hits.

Stored local-copy JSON length is **59,414,932 bytes** in every arm (median and p95). It contains derived data; this size alone does not establish canonical-input or exact-output equality.

## Endpoint memory observations

All six optional forced-GC probes of the geometry-worker isolate succeed. Whole-worker retained bytes remain unavailable (`null`) in both arms.

| Bytes               |   Disabled median / p95 |    Enabled median / p95 |
| ------------------- | ----------------------: | ----------------------: |
| JS isolate heap     | 15,861,520 / 15,861,708 | 21,729,280 / 21,730,408 |
| CDP embedder heap   |         43,328 / 43,328 |         43,336 / 43,336 |
| CDP backing storage | 37,919,011 / 37,919,011 | 50,911,940 / 50,912,354 |

Maximum accounted measurement bytes are **0 / 16,364,678**, reported checkpoint/topology estimates **7,403,328 / 143,914,441**, and WASM linear-memory capacities **130,023,424 / 272,498,688** (disabled / enabled). Accounting, estimates, capacity and CDP metrics describe different, potentially overlapping quantities. They are not summed or substituted for a whole-worker retained-memory bound. The proposed 8 MiB allowance applies to an additional detached branch record; it is not a total-cache or enabled-minus-disabled heap ceiling.

## Private exactness and sustained lifetime

The unchanged private one-edit oracle and seven selected mutation/lifetime suites pass **93 tests**. The owning-kernel raw comparison matches all **3,204,155 serialized bytes** across 17 bodies, including consumed construction bodies; normalized publication matches across 720 faces. The unchanged-source hit also compares full published buffer bytes and structure. The changed eager oracle restores 16 features, replays 12 plus three prepared features, measures seven bodies and reuses 10 measurements. The unchanged strict public reproduction passes separately.

Publication retains the documented normalization: omit `updatedAt`, compare cross-arena mesh kind/triangle count, and zero only the recognized-opening diagnostic arena indices `faceA`/`faceB`. No topology references, lineage, validation warnings or provenance fields are discarded. Raw B-rep comparison separately checks every serialized byte without numeric tolerance. Per-body serialization does not establish cross-body shared-topology identity.

The unchanged browser session completes all **80 edits**, with **7/7 raw/publication comparisons** matching: initial, after 20/40/60/80 edits, after refusal recovery and after worker restart. Each comparison has 17 bodies / 720 faces and zero warnings; serialized byte lengths vary with the authored parameter changes. Final result: **zero page errors, zero acceptance failures, `accepted: true`, exit 0**, and unchanged source bytes.

At 80 edits the main adapter has performed 166 syncs in four arenas, including **three replay-budget recycles** and **252 retired checkpoints**. The five available retired-checkpoint restore probes are all rejected; **220 prepared-feature reuses** are observed. Owner identities and accounted-byte sums agree at every checkpoint. Production limits remain 32 checkpoints, 128 MiB for measurement and 8 entries / 32 MiB for the worker memo. The memo records 159 evictions before recovery and 161 afterward.

A separate pressure adapter uses the existing calibrated **9,280,487-byte test cap**, admitting each individual entry while excluding the complete working set. Production defaults and all pressure assertions are unchanged. All four real eviction passes match both oracles, with retained plus remeasured bodies accounting for the complete result:

| Pass | Evicted bodies remeasured | Retained hits | Accounted bytes | Raw / publication |
| ---- | ------------------------: | ------------: | --------------: | ----------------- |
| 1    |                         7 |            10 |       8,337,384 | match / match     |
| 2    |                        10 |             7 |       7,808,593 | match / match     |
| 3    |                         7 |            10 |       8,337,384 | match / match     |
| 4    |                        10 |             7 |       7,808,593 | match / match     |

The negative-height edit is refused without changing the committed value. The next valid edit completes a newer live exact version and matches the fresh oracle. IndexedDB confirms the durable value before explicit worker termination. The old geometry-worker target disappears; reload creates a new target and new arena, with zero restored features and zero reused measurements on its first sync, followed by fresh-oracle equality. These observations now exercise the lifetime conditions absent from the first candidate.

## Sustained post-GC observations

Fresh/pressure adapters are disposed, captured arrays and held documents released, and worker GC forced before each sample. Retired-kernel diagnostics retain only weak references. These are instrumented-worker observations; temporary oracle work can raise WASM high-water capacity.

| Phase    | JS isolate heap, bytes | Embedder heap, bytes | Backing storage, bytes |
| -------- | ---------------------: | -------------------: | ---------------------: |
| initial  |             21,452,576 |               42,088 |             42,496,183 |
| block-1  |             35,321,680 |               42,088 |             54,893,429 |
| block-2  |             32,986,420 |               42,088 |             54,913,067 |
| block-3  |             30,249,688 |               42,088 |             54,927,231 |
| block-4  |             28,421,212 |               42,088 |             54,938,751 |
| recovery |             28,636,804 |               42,088 |             54,947,286 |
| restart  |             21,586,768 |               42,088 |             42,592,519 |

The private session demonstrates exercised cache retirement/recycling safety on this trace. These separate observations still do not establish a whole-worker/process/GPU retained total or an accepted retained-memory ceiling. No growing or slow observation is excluded, and no sum of these fields is presented as total memory.

## Verification and remaining requirements

All required local gates run serially after the browser sessions stop, on clean **`64f0706512425b41bbf69f12dd4399b2cc93c274`**:

| Command                   | Result |
| ------------------------- | ------ |
| `pnpm lint`               | pass   |
| `pnpm typecheck`          | pass   |
| `pnpm test`               | pass   |
| `pnpm test:parity-corpus` | pass   |
| `pnpm build`              | pass   |

Lint has zero errors and 17 existing warnings. Full unit verification passes 5,820 root tests (eight existing skips) and 3,474 web tests; parity passes 220 tests (one existing skip). The full build includes paired-WASM byte verification, provenance and bundle gates. Hosted validation and the full browser E2E matrix are reported separately on the current PR head; local/private observations are not a hosted-CI claim. Public CI has no private input and does not replace this campaign.

Reproduce with the [candidate record](h02-lineage-runtime-candidate.md), [matched-arm commands](../2026-10-15/h02-matched-cache-benchmark.md#reproduction) and [sustained command](h02-m5-pro-qualification.md#reproduction-and-verification). Run the unchanged sustained session first and then alternating matched pairs in clean pinned checkouts, using fresh outside-repository outputs and pair IDs. Retain every failure and slow sample, and keep validation suites separate from timings. A private integrity manifest retains this campaign's immutable identities, input verification, raw evidence and every observation. Earlier campaigns and local work are preserved separately.

Quiet target-device timing and whole-worker retained-memory acceptance remain open. The proposed detached Text branch remains unimplemented and unaccepted: the pinned kernel restores ancestors and retires descendants, so branch-preserving kernel support and complete interval dependency/effect analysis are still required. Unknown dependencies must miss; all mutation, exactness, lifetime and memory criteria in the [design](../../plans/h02-private-holder-cache-design.md#acceptance-benchmark-before-implementation) remain unchanged. Existing-cache speedup and matching publication cannot accept that branch. **H02 stays Partial.** No paid Apple Silicon CI, merge, manual deployment or migration is performed.
