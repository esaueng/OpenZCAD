# Bounded history prefix retention

Histories longer than 32 features previously disabled prefix caching completely.
A 33-feature import-plus-boxes workload consequently remeasured an unchanged
import on every edit. The adapter now retains the earliest eligible prefixes up
to `historyCheckpointLimit` (default 32), then builds the remaining suffix
exactly without retaining further checkpoints. No kernel algorithms, geometry
tolerances, dependency pins or measurement validity conditions change.

## Ownership and invalidation

- The adapter owns one history kernel and a contiguous prefix table. Table entry
  i owns kernel checkpoint i and an isolated JS build snapshot. Suppressed and
  refused features also occupy prefix entries, preserving warning attribution.
- Prefix digests still cover feature content/order/suppression, sketch objects,
  resolved parameter dependencies and imported-source content. Project identity,
  units, scope errors and Bezier profile mode guard global reuse.
- Restore selects the longest matching retained prefix. Remus `restore(k)` keeps
  checkpoints 0 through k and discards later checkpoints; the adapter truncates
  its table in lockstep. Every feature after that prefix is replayed, even when
  unchanged. Telemetry never advertises the uncached suffix as restored.
- With no matching prefix, disabled retention, a project/scope change or failed
  restore, the old kernel and measurements are released before an exact rebuild.
  Thrown replay/checkpoint failures invalidate both owners for sync, export and
  recognition. A measurement failure also invalidates both owners.
- Exports, mesh-quality queries and imported-face recognition share the history
  kernel. Their cleanup restores the last retained prefix, retiring suffix and
  scratch geometry. If cleanup fails or no prefix exists, the kernel is freed.
- Measurements still require matching solid handles, analysis key, strict-union
  mode, mass-property inclusion, imported recognition mode and face count.
  Remus does not reuse retired entity handles. Measurement byte accounting and
  dead-body eviction remain unchanged. Disposal clears both cache owners.
- Zero, negative and NaN limits disable retention. Fractional budgets retain
  only complete prefixes. Explicit Infinity preserves the existing unlimited
  opt-in. The default count remains 32; it is **not a strict byte limit**.

The inspected kernel contract is Remus `b13ff97b16c405eafd6707ad9098297d867a385f`,
`crates/wasm/src/bindings/checkpoint.rs`. `discardCheckpoint(k)` also discards
all descendants, without changing current topology. Temporary measurement
checkpoints are restored and discarded before returning. No kernel transaction
or adaptive scheduling redesign is included here.

## Qualification

Baseline OpenZCAD: `6b064b49055b36c032cfedc7a62625ab47d9427c`. Sequential runs used
the same optimized remus-wasm 2.130.33 package, Node 24.19.0 and Windows ARM64
on Snapdragon X X126100. WASM SHA-256:
`02c1e465c025ce80e812263fa7987543437ab639f054f7738f274ce176105491`.
The plane-frame optimization was absent from both variants. The private import
fixture and machine-local investigation artifacts are not included in this PR;
synthetic controls and an opt-in local STEP fixture are supported by the harness.

No tests, builds or other benchmarks ran alongside the retained latency samples.
Controls used five warm samples per edit location; the imported workload used
three late edits. Cold figures are one adapter-cold build per workload, not a
fresh process per row. The first row includes first-use runtime effects.

| History | Cold ms before → after | Late-edit median ms before → after | Replayed before → after | Reused measurements after |
| --- | ---: | ---: | ---: | ---: |
| 31 boxes | 80.916 → 82.765 | 2.436 → 2.506 | 1 → 1 | 30 |
| 32 boxes | 18.927 → 18.956 | 1.336 → 1.352 | 1 → 1 | 31 |
| 33 boxes | 16.698 → 22.487 | 20.671 → 1.226 | 33 → 1 | 32 |
| 48 boxes | 23.740 → 26.126 | 23.705 → 8.718 | 48 → 16 | 32 |
| 80 boxes | 40.201 → 41.432 | 38.915 → 24.580 | 80 → 48 | 32 |
| Import + 31 boxes | 20,774.858 → 20,280.562 | 4.094 → 3.278 | 1 → 1 | 31 |
| Import + 32 boxes | 20,324.470 → 20,025.050 | 20,496.340 → 1.873 | 33 → 1 | 32 |
| Import + 47 boxes | 20,483.613 → 20,208.560 | 20,322.113 → 11.741 | 48 → 16 | 32 |

Early edits still rebuild everything and pay snapshot overhead. For 33/48/80
boxes, first-edit medians were 16.039→18.464, 22.934→25.939 and 39.861→42.580 ms.
Middle edits were 16.278→13.570, 23.396→17.155 and 40.466→24.955 ms; replay counts
changed from 33/48/80 to 17/24/48. These small sequential samples support the
specific cutoff fix, not universal speedup or tail-latency claims.

All 39 benchmark/session warm-versus-fresh comparisons passed with identical
normalized derived-state hashes. Normalization excludes only root `updatedAt`
and mesh vertex/index layout; it compares topology, references, face ranges,
edges, bounds, mass, volume, warnings, mesh kind and triangle count. Reused
import meshes are also compared byte for byte in regression coverage.

The focused suites pass 33 tests, covering 31/32/33/48/80 features, early/middle/
late edits, append/shorten/reorder/suppress, empty-history cleanup, parameters,
sketches, source changes, units, project identity, analysis options, retained
failure warnings, rollback, undo/redo, export, repeated restores and injected
checkpoint/restore/measurement failures. Tests inspect both adapter records and
actual kernel checkpoint counts, including a failure after kernel allocation.

At the measured implementation's review: full root tests passed 2,945 with six
skips; web tests passed 1,321; parity corpus passed 174 with one skip. Lint had
zero errors and 19 existing warnings; typecheck and full build (including size
and provenance gates) passed. Missing-shell policy-test failures on the initial
Windows run were resolved with GNU Bash; all 37 policy tests then passed. This
is Windows validation, not a Linux run. PR CI reports integration separately.

Two fresh browser contexts using Edge/Chromium 153.0.4234.48 at 1440×1000 verified
import, exact rendering, three edits, invalid-input refusal, undo/redo and STEP
export of all 33 solids. The worker replayed only the last box. Six command-to-
changed-geometry draw samples were 66.1–74.6 ms (median 69.55 ms); cold import/
render was about 20.7 seconds. There were no runtime exceptions or error overlay.
The local archive-service stub returned one 404 after successful download.
This is not Chrome-specific, physical-display, mobile or full-browser-suite
qualification. The committed browser test defaults to 33 synthetic boxes.

## Memory observations and follow-up

Each session made 2,000 alternating late edits in a 33-feature history. Values
below are measurements at edit 100 and 2,000, before parity and disposal.

| Session | Retained count | Kernel WASM MB 100 → 2,000 | RSS MB 100 → 2,000 |
| --- | ---: | ---: | ---: |
| Baseline boxes | 0 | 1.77 → 1.77 | 304.53 → 406.28 |
| Fixed boxes | 32 | 10.29 → 51.58 | 187.07 → 349.72 |
| Fixed import + boxes | 32 | 29.49 → 58.85 | 227.30 → 379.10 |

The import translator additionally held 2.03 MB. Final measurement buffers were
7,920 bytes for boxes and 666,828 bytes for the imported workload. Disposal left
zero checkpoints and zero accounted measurement buffers; linear memory did not
shrink. RSS includes the runtime, harness and GC effects. It cannot estimate
individual checkpoint cost. Final-ten-edit medians were 16.878 ms baseline boxes,
4.232 ms fixed boxes and 4.903 ms fixed import plus boxes.

Retired handle storage grows despite a stable snapshot count. The old over-limit
path recreated its kernel on every sync, explaining its flatter WASM size at
the cost of full replay. These are accelerated late-edit sessions, not mixed
early-edit or multi-hour interactive qualification. No 2,000-edit baseline
import session was run. Sparse/adaptive placement and arena compaction remain
outside this bounded change.

A later byte-budget design needs kernel accounting for live topology, exclusive
and shared snapshot allocations, retired handle slots and allocator high-water
storage. Account for JS snapshots, imports, measured buffers and worker copies
separately. Collect prefix length, source size, topology counts, replay and
measurement time saved, allocation deltas and post-disposal observations.
Implement conservative byte admission before adaptive placement. Eviction must
respect stack descendants; sparse retention needs explicit prefix lengths.
Compaction or generational handles require a separate stale-handle-safe design.

## Reproduction

Use the frozen dependency install and run benchmarks sequentially from the
repository root. These commands use POSIX shell syntax (PowerShell users can
set equivalent `$env:` variables). No private fixture is needed for controls.

```sh
pnpm install --frozen-lockfile
pnpm exec vitest run test/bounded-history-cache.test.ts test/incremental-rebuild-cache.test.ts
HISTORY_OUT=artifacts/history-cache/fixed HISTORY_SAMPLES=5 \
  node --expose-gc node_modules/vitest/vitest.mjs run --config test/perf/history-cache.config.ts
HISTORY_OUT=artifacts/history-cache/session HISTORY_SESSION=2000 \
  node --expose-gc node_modules/vitest/vitest.mjs run --config test/perf/history-cache.config.ts
pnpm exec playwright test test/e2e/bounded-history-cache.spec.ts
```

For baseline measurements, prepare a separate checkout at the baseline SHA with
its frozen dependencies installed, and set `HISTORY_MODE=baseline` plus
`HISTORY_BASELINE_ROOT` to its absolute path while running the same harness from
this checkout. Set a separate `HISTORY_OUT` directory for each run; JSONL appends.
The baseline option changes the adapter import, not the runtime geometry engine.

For an owned local STEP fixture, set `HISTORY_FILTER=towel`, `HISTORY_SAMPLES=3`
and `HISTORY_TOWEL_STEP` to its path. The label `towel` names the workload; other
fixtures will have different timings. Browser tests accept `HISTORY_TOWEL_STEP`
as well, and optionally `HISTORY_BROWSER_OUT` for JSONL timing output. Keep model
files, local paths and private screenshots out of commits.
