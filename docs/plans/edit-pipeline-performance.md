# Edit-to-frame performance (H02 / W02)

Implement the 7 October source-based investigation as one coordinated OpenZCAD / Remus change. ROADMAP.md remains the delivery ledger. The baseline is OpenZCAD dcfb5175 with paired Remus packages 2026.1.42: three independent Node runs on the public 160-face STEP fixture gave a 3,111 ms first-offset median, including 1,164 ms volume, 652 ms feature claims, 550 ms edge relations, 149 ms display tessellation and 133 ms face movement. These are adapter timings, not browser frame timings.

Implementation order and acceptance:

1. Publish a separately typed, validated geometry snapshot before optional recognition and quantities. A geometry snapshot carries no invented volume or recognition proof, is never persisted as a completed derived result, and cannot satisfy an explicit validation/export request. Match project/version and discard superseded publications. Keep all exact geometry acceptance gates.
2. Yield to worker message tasks between bounded history batches and analysis jobs. Keep memo scopes synchronous, close cancellation tokens on interruption, retain consistent checkpoints, and preserve explicit request delivery. A running single WASM call remains synchronous; measure that limit.
3. Transport changed bodies with explicit base/publication revisions and full-result recovery. Preserve main-thread object identity for unchanged bodies. Metadata-only changes must not update mesh buffers or normals. Strip derived state only from rebuild inputs; preserve selected metadata for query request types.
4. Consume owned mesh outputs without redundant copies. Preserve cache ownership when transferring buffers and verify buffers survive freeing the WASM result and later memory growth.
5. Instrument and optimize the first edited-solid volume reading and edge/feature recognition. Reuse only verified content and dependency neighborhoods; retain fresh/warm numerical and recognition parity. Never restore the removed derived-volume seed or silently coarsen measurement tolerances.
6. Account for checkpoint bytes and mutation/restore costs; apply a bounded memory policy while preserving retirement and rollback. Extend independently reusable history only to audited builders, with digest and reference parity tests.
7. Add revision/request traces from dispatch to first frame and analysis completion. Compare the same public STEP fixture and primitive-history workloads before/after. Exercise stale analysis, superseding edits, metadata-only results, delta recovery, undo/redo, topology changes and disposal.

Run lint, typecheck, root and web unit suites, parity corpus, build and focused browser coverage. Remus changes require format/lint, relevant native correctness tests, boundary checks, paired WASM build and consumer checks. Record actual results and remaining limits in this document and the H02/W02 roadmap rows. Open reviewable PRs; merging or deploying is separate from this implementation request.

Implemented contracts:

| Area                | Result                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Accepted geometry   | An ephemeral `GeometryReadyState` contains validated mesh, picking topology and body metadata. It omits volume and mass properties. Pending UI says “Preparing model details…”; current-revision proofs, quantities and exact completion remain gated.                                                                                                                   |
| Scheduling          | Real worker task yields between feature batches and analysis jobs, with synchronous memo scopes and cancellation checks. Per-adapter history access is serialized across yields; disposal cancels old work and frees its arena safely.                                                                                                                                   |
| Transport/rendering | Session, publication and base revisions describe body deltas. Missing bases recover with a full publication. Transfer buffers belong to packets; cached buffers stay owned. Unchanged bodies retain identity, and analysis-only updates reuse installed meshes and normals.                                                                                              |
| Mesh output         | Consume-once owned WASM arrays remove the Rust getter clone and redundant adapter copies. Existing getters retain their copy contract.                                                                                                                                                                                                                                   |
| Volume/recognition  | Measurement omits only boundary shading normals; positions, indices, tolerances, repair and integration remain identical. Selected face queries batch needed edges against the whole solid, preserving the existing probe policy and verdicts. Bulk proof collection remains complete.                                                                                   |
| Checkpoints         | Immutable NURBS arrays share storage across topology clones. Admission estimates include unique topology/NURBS storage, retired slots and the next mutation copy, under a 128 MiB default in addition to 32 checkpoints and 512 replayed builders. Estimates exclude several allocations and do not cap process RSS.                                                     |
| Observability       | Bounded revision timings cover packing, receipt, worker stages, geometry, analysis, installation and the rendered frame. Packet metrics include queue/worker/encoding time, cache work and transferred bytes. Opt-in diagnostics add accounted storage and allocated WASM pages; kernel phase traces distinguish volume, meshing, relations, restore and first mutation. |

A single WASM call still blocks its worker until it returns. A separate analysis arena, browser threads, GPU modeling, trimmed-face integral reuse and general mixed-history reuse remain conditional on measurements and correctness proofs. The existing audited independent-primitive reuse remains in use. Allocated WASM pages and accounted cache bytes are separate from host/GPU memory and process peak RSS. Frame timing ends after `renderer.render`; physical display presentation is outside this probe.

Measured qualification (7 October 2026):

The final paired packages are `2026.1.45`, pinned to Remus
`a04b5c8689f5dd12b22f1b6246921779ff10abb6` ([Remus PR #975](https://github.com/esaueng/remus/pull/975)),
which incorporates the reviewed correctness and performance sources in one
canonical package pair. This changes the WASM bytes from the earlier #970
candidate; the historical samples below have not been rerun for this combined
release.
The 7 October samples used the earlier #970 qualification package, whose
equivalent rewritten pin is `1482487755a2a435c8134d31d43eb3e98adffdeb`.
That candidate's final commit corrects a native test's layout guard for shared
NURBS storage; its shipped WASM bytes are identical to the `4e6584f1`
measurement build.
Three independent, quiet Node processes used the same public STEP file, +X face
(area 1045.93), edit distances and Linux environment as the baseline. Times
below are medians in milliseconds. Geometry-ready is the validated adapter
snapshot; it is separate from browser rendering and complete analysis.

| Operation                                 | Baseline complete | New geometry-ready | New complete |
| ----------------------------------------- | ----------------: | -----------------: | -----------: |
| Cold import                               |             8,090 |              4,071 |        7,717 |
| First face offset, −6                     |             3,111 |                719 |        3,011 |
| Second face offset, −7 from the same base |             2,935 |                701 |        3,016 |
| Undo to import                            |             2,423 |                427 |        2,564 |

The first edit publishes geometry about 77% earlier than the baseline's only
publication. Complete first-edit time changes by about −3%; second-edit and
undo completion are slightly slower in these samples. Earlier feedback is the
main demonstrated gain. Three runs do not establish a target-device p95 or a
universal full-regeneration speedup. Source volume is exactly
50241.713212494236 and the −6 result is exactly 40548.36304506951 in every run,
matching the baseline. All runs retain 160 faces and report no warnings.
Peak child-process RSS across the three benchmark commands is 492,440 KiB
(about 481 MiB). Baseline RSS was not recorded, so this is no memory-improvement
claim; it excludes browser/GPU memory and is distinct from checkpoint estimates.

The package qualification also corrects 3MF unit handling after the upstream
translator began returning millimetre vertices, while scaling raw instance
translations once. Coplanar nested glyph regions now produce strictly valid
fuses in Remus. OpenZCAD verifies exact union acceptance and retains qualified
retry guards; on-face text regressions check closed-form volume, mesh closure
and preserved voids through STEP export and point classification. No tolerance,
mesh-error or acceptance threshold is relaxed.

Reproduce the adapter comparison with the installed immutable pin:

```bash
OFFSET_PERF_STEP=/path/to/remus/crates/io/tests/data/shapr3d_hammer_holder.step \
  OFFSET_PERF_AREA=1045.93 OFFSET_PERF_FULL=1 \
  pnpm exec vitest run test/perf/offset-face-perf.test.ts \
  --maxWorkers=1 --reporter=verbose --silent=false
```

Set `OFFSET_PERF_KERNEL_PHASES=1` for a separate tracing run; keep those timings
out of the quiet comparison. The native kernel qualification includes cold/warm
position/index parity and later display-normal parity, selected-edge bit parity,
recognition goldens, NURBS serialization/clone parity, retired-handle storage,
and owned-array lifetime checks. The ordinary paired WASM build, deep smoke,
installed-tarball regressions, committed integrity and version guard pass locally.

The five-sample 33-independent-box check retains one executed builder and one
measurement per warm edit, with 32 restored bodies and 32 reused measurements.
Warm/fresh normalized publication parity passes (the existing harness excludes
`updatedAt` and mesh vertex/index layout). New complete medians are 27.6 ms late,
18.2 ms middle and 19.2 ms early, versus baseline 17.5 / 17.7 / 12.3 ms from three
samples; cold is 210 ms versus 148 ms. Scheduling, ownership and accounting add
work to this already cheap workload. These results do not justify a broader
history rewrite as a response to the imported-face bottleneck. Peak checkpoint
count is 22; one late-edit sample accounts for 3.22 MB across 23 unique topologies,
3.59 MB including the next mutation, 0 NURBS bytes, 6.09 MB allocated WASM pages
and 573 KB measured-shape retention. Highest sampled process RSS is 252 MB;
these distinct measurements are not interchangeable.

The separate kernel trace keeps curved-face meshing and full recognition as
the dominant optional work. The first offset reports 1,220 ms inclusive volume,
1,057 ms curved-face meshing across display/quantity calls, 876 ms relations,
838 ms recognition, 3.9 ms restore and 2.4 ms quantity content-key construction.
Those overlapping, instrumented durations are diagnostic rather than quiet
benchmark samples. Display boundary normals still run; the quantity route
omits that shading pass. A long single WASM call still blocks its worker, so
these changes do not prove prompt interruption inside volume/recognition.

Production bundle qualification keeps every existing size gate. Worker and page
builds split imported-feature analysis and synchronous query memo helpers;
packet, revision and reference helpers reuse the existing model chunk. The page
entry is 508,393 bytes and the largest worker adapter chunk is 509,983 bytes,
both below the unchanged 512,000-byte default. Worker splitting preserves
module evaluation order and avoids recursively collecting unused dependencies.
The paired installed-byte/provenance check and full production build pass.

Local qualification on the final pin passes lint (18 existing warnings,
zero errors), typecheck and all 182 parity-corpus tests (one existing skip).
The full serial root run passes 4,000 tests, with eight existing skips; sequential
fillet and two font audits exceed their unchanged time budgets. A quiet rerun
passes all six font-audit tests and all 12 imported-cache tests. Cache coverage
also passes in 20 independent processes, retaining geometric equivalence and
direct, unrounded volume assertions with immutable normalized snapshots.
The quiet sequential-fillet retry remains about 0.5 seconds above its 60-second
budget. An independent control using the original adapter from OpenZCAD
`23e893da` and original Remus `f23349aa` also times out on the same host with the
same assertion and budget. This is an unresolved host qualification limit;
the test budget and assertions remain unchanged.
Remus CI passes full native workspace tests, doctests, Clippy, policy checks,
paired package rebuild/integrity and the shared-version guard.
All 2,069 web tests pass across 235 files against the final pin. Remus CI's
native run passes 7,523 tests, with 50 existing skips; its final aggregate check
is green.

Headless Chromium 151 with SwiftShader, at 1440×1000 on the same Linux host,
passes compound STEP offset/undo/redo/reopen and both parameter-validation
flows. After qualifying accepted-revision traces, five applied box edits have
a 350 ms input-to-renderer-frame median (274–689 ms range); analysis-ready is
316 ms median. Frames are checked to follow geometry acceptance and installation,
including a commit that reuses its preview's mesh. Runtime errors are empty.
The staged-geometry browser test holds the completed packet, observes the
pending revision's rendered mesh and disabled proof-dependent actions, then
releases analysis and verifies no further mesh installation. These are local
software-renderer observations, without a browser baseline or target-device
p95 claim. Full browser shards remain PR CI qualification.

The final 2,000-edit, 33-box session passes fresh normalized publication parity.
Both checkpoint owners agree and satisfy the 32-count limit at every edit;
sampled counts are 22. At edits 100 / 2,000, accounted topology storage is
4.37 / 8.50 MB, projected next mutation is 5.88 / 14.15 MB, allocated WASM pages
are 8.19 / 15.53 MB and process RSS is 227 / 383 MB. The highest sampled
accounted storage is 8.95 MB and sampled process RSS is 384 MB. Disposal clears
both owners and measured-shape retention; allocated pages and process RSS do
not shrink in this run. This accelerated primitive session does not establish
a process-memory ceiling or private mixed-history retention.

Reproduce the session:

```bash
HISTORY_COUNTS=33 HISTORY_SESSION=2000 HISTORY_FILTER=boxes \
  pnpm exec vitest run --config test/perf/history-cache.config.ts \
  --reporter=verbose --silent=false
```
