# H02 measurement cache safety and private-holder evidence

This change implements the justified measurement-safety portion of
[the private-holder design](../../plans/h02-private-holder-cache-design.md).
H02 remains partial. No detached Text-branch cache is enabled, and no 20% p95
improvement is claimed.

## Contract and implementation

The frozen kernel/translator pair is Remus
`960e777cb1c47b24abe85c78d6a5599c11e00c15`, unchanged in this PR. The audit read
that commit's `crates/wasm/src/bindings/checkpoint.rs` and
`crates/topology/src/arena.rs`. Restore retains ancestor checkpoints and makes
post-checkpoint handles inaccessible without reusing their slots. A retirement
observed before the checkpoint barrier is not undone. Discard removes snapshots
without restoring topology. Tests exercise the installed WASM for prefix-solid
and face preservation, descendant-checkpoint truncation, repeated restore and
permanent solid/face/edge/vertex retirement after new allocations.

The proposed detached interval is blocked by a specific missing contract:
restoring the old post-Text checkpoint cannot also preserve the newly edited
holder state. There is no audited branch-preserving restoration operation in
this pin or dependency/effect analysis for arbitrary Text intervals. Primitive
tail reuse remains primitive-only. Newly compiled recipes already retain the
fixed Text import in their existing prefix; `Keep text together` depends on the
edited opening and height and must execute. Saved histories are not reordered.

Existing measurement entries now own structured-cloned payloads, and returned
topology cannot mutate lineage leaves shared with history snapshots. The key
covers solid identity, strictness, recognition, analysis, lineage and import
diagnostics. Kernel pin/code and units/Bezier/scope/source inputs remain guarded
by the adapter lifetime and existing history digests. Mass properties are still
queried separately under the live-build epoch and never enter this payload.

Candidate hits recount the complete solid/face/edge/vertex handle record and
relaxed/strict validation verdicts. A failed probe abandons every arena-bound
owner and retries once in an empty kernel. Checkpoint table IDs and stack count
are reconciled before reuse, after restore/discard and during allocation;
restored prefix solids are probed before replay. Genuine builder/measurement
errors still propagate after invalidation, and fresh invalid measurements keep
their refusal diagnostics and are not cached.

Recognition, exact carrier/lineage publication, strict-union closure checks,
warning attribution and export paths retain their existing gates. Names,
colors, warnings and wrappers are derived again each sync.

The existing 32-checkpoint, 32 MiB derived rebuild and 128 MiB measurement
ceilings remain. Measurement accounting now includes buffers plus serialized
metadata, provenance, keys and handle records. It is an estimate, not a worker
heap bound. Oversized values are not retained. Branch retention is **zero**;
no additional 8 MiB branch allocation is introduced.

## Private benchmark

Machine: Apple M5 Pro (15 cores), 48 GB RAM, macOS 27.0, Node 22.23.1,
Playwright 1.62.1 headless Chromium, production Vite preview. Baseline:
OpenZCAD `9d75ef9be00397f2a06f58f609af7db6ee855999`; comparison: this change.
Both use the same frozen dependencies and local private STEP.

Three serial runs per final build; baseline precedes hardened runs. No tests or other
benchmarks run concurrently with the retained samples. p95 uses nearest rank
and is the maximum of three samples; this small sequential comparison does not
establish tail latency across hardware. These are main-versus-safety timings,
not enabled-versus-disabled evidence for an unimplemented branch cache.

One exploratory safety run passed but took 11.98 s for the first settled edit.
It exposed redundant validation when writing measurements: strict union
verdicts already established by the gate were queried again. The final code
records verdicts from the completed measurement pass on misses and independently
recounts/revalidates on hits. The exploratory sample remains local and is
excluded because it ran a different implementation, not because it was slow.
A regression prevents that redundant write-time validation from returning.

The H02 browser harness checks durable values after reload, a successful commit,
fresh live exact readiness, zero warnings, within-run latency budgets and no
fixed Text replay. Preview timing is reported separately. Raw model files,
documents and browser samples stay local; only aggregate results belong here.

| Metric (ms)                                          |   Main median / p95 | Hardened median / p95 |
| ---------------------------------------------------- | ------------------: | --------------------: |
| warm edit before reload                              |   8,724.4 / 8,806.2 |     8,641.0 / 8,650.2 |
| first edit after reload                              |   8,669.6 / 8,984.7 |     8,696.6 / 8,732.1 |
| second edit after reload                             |   8,698.7 / 9,039.7 |     8,695.5 / 8,963.2 |
| immediate edit after reload                          | 35,839.6 / 37,741.2 |   35,910.9 / 36,167.7 |
| Reload to exact readiness                            | 29,595.6 / 29,747.7 |   29,530.8 / 29,774.1 |
| Suffix replay (preflight)                            |   3,149.9 / 3,254.5 |     3,144.6 / 3,164.5 |
| Growing-holder union (within replay)                 |   2,706.3 / 2,797.6 |     2,702.4 / 2,720.4 |
| Fixed Text import (restored)                         |           0.0 / 0.0 |             0.0 / 0.0 |
| Parameter-driven text placement (within replay)      |           5.9 / 6.2 |             5.8 / 5.9 |
| Body measurement (preflight, no nested double count) |   4,187.4 / 4,364.9 |     4,187.3 / 4,187.8 |

First-edit median changes 0.31%; sample p95 changes -2.81%. The 20% p95 improvement target is not met. Union and placement are part of replay, not extra costs to add to total exact completion. Worker rows cover exact preflight; Enter-to-exact wall time also includes live publication and scheduling. Preview-install is unavailable (`null`) in all six retained samples and is not substituted for exact readiness.

Final cache events restore 16 features and replay 15 at the edit, measuring nine bodies and reusing eight. Measurement miss reason is `solid-handles`, preserving exact measurement of edited union results. No integrity recovery occurs in the retained private runs. Peak accounted measurement retention over the final runs is 16,361,085 bytes (15.60 MiB), below the unchanged 128 MiB estimate ceiling. This includes metadata/witnesses and cannot be compared directly with the former buffer-only accounting. Actual worker heap was not measured.

## Equivalence and retention

The supplied private STEP is available and was exercised locally. Its unchanged
source measurement hit matches the entire mesh/topology payload byte-for-byte
and structurally. The compiled holder reload and first height edit complete
without exact or feature warnings, restore the Text prefix and execute the
parameter-driven placement.

The opt-in fresh-build publication oracle **fails** on both unmodified baseline
`8da82a0b` and this change. Both runs report the same differing field paths:
73 `topology.faces.*.geometry.blendRegionKey` values and eight
`topology.lineageDiagnostics.*.message` values across eight of 17 bodies.
All root fields and other compared body fields match (720 faces total).
These keys/messages are not stripped or relaxed to make the assertion pass.
This demonstrates a pre-existing publication equivalence gap; it does not
prove a geometric defect or satisfy H02's exact provenance acceptance gate.
The test retains the failing assertion and is opt-in because the source is
private. Local diagnostics emit only field paths/counts, never private values,
geometry or IDs. Serialized raw B-rep equivalence is also unproven.

A separate public optimized-WASM session ran 2,000 edits on 33 independent
boxes. All sampled adapter/kernel checkpoint counts agree at 22 (ceiling 32),
accounted measurement retention peaks at 566,086 bytes and the final normalized
fresh-build oracle passes. Disposal leaves zero checkpoints and zero accounted
measurement bytes. WASM linear memory grows from 5,701,632 bytes to 17,825,792
bytes, with that high-water size unchanged from sample 1,000 to 2,000. Process
RSS grows from 178,733,056 to 299,565,056 bytes by edit 2,000 and remains
302,841,856 after the oracle/disposal. GC was not exposed in this run; freeing
adapter owners does not prove process-memory reclamation. This primitive Node
session is not evidence for mixed private browser-worker retained heap.

Public regressions cover caller mutation and buffer transfer, imported lineage
ownership, strict and relaxed validation disagreement, same-count handle
substitution, stale probes, checkpoint disagreement, mode/provenance changes,
invalid measurements, oversized entries, repeated edits, refusal, disposal and
kernel recreation. The 270-edit dependent history crosses the replay-work
recycle boundary and compares every published topology/lineage/validation field
to an uncached oracle at intervals. The existing bounded-history suites cover
sparse checkpoint eviction, reorder/suppression, source/sketch/unit changes,
export cleanup and attributed failure recovery.

Exact cache hits compare full buffer bytes and structure. Fresh replay can
change vertex order and triangulation diagonals; cross-arena equivalence keeps
the established boundary of comparing triangle counts plus every other
published field. Only timestamps and the two explicitly arena-bound opening
diagnostic face indices are normalized in the private oracle. This is not raw
private serialized B-rep byte equivalence, which remains an acceptance blocker
for a future branch cache. Actual browser worker retained heap is unavailable;
accounted bytes are not substituted for it.

## Local verification

- `pnpm install --frozen-lockfile`: passed; Remus pin unchanged.
- `pnpm lint`: passed with 19 existing warnings and no errors.
- `pnpm typecheck`: passed, including the opt-in oracle diagnostics.
- `pnpm test`: root 3,182 passed / seven skipped; web 1,500 passed.
  The private oracle is one of the default skips; its explicit failure above
  is not counted as a pass.
- `pnpm test:parity-corpus`: 174 passed / one skipped.
- `pnpm build`: passed, including bundle/provenance gates. Existing kernel
  raw-size review warning remains.
- Focused Playwright: six passed (`bounded-history-cache`, `growing-holder`,
  synthetic and lettered `perf-holder-reload`) with `OZ_PERF_BUDGET=1`.
- Private production-preview H02: three baseline and three final runs passed
  readiness, commit, exact warning, Text-replay and within-run ratio assertions.
  The separate 20% improvement acceptance target fails.
- Opt-in private publication oracle: failed on baseline and final build at the
  unchanged final equivalence assertion; source cache-hit assertion passed.
- Public 2,000-edit session: passed, with final normalized oracle and checkpoint
  count assertions. The dependent 270-edit regression also passes.

No merge, deployment, migration or Apple Silicon workflow dispatch was run.
Hosted PR checks and production behavior are separate from these local results.

Reproduce with `OZ_PERF=1 OZ_PERF_BUDGET=1`, a local
`OZ_PERF_HOLDER_STEP`, `OZ_PERF_HOLDER_PARAMETER=holder_height` and
`pnpm exec playwright test perf-holder-reload --grep 'private holder' --repeat-each 3 --workers 1`.
Set `OZ_PERF_OUT` outside the repository for private samples. Run
`OZ_PERF_HOLDER_STEP=/path/to/source.step pnpm exec vitest run test/h02-private-holder-cache.test.ts`
for the opt-in oracle check. It is skipped without the private source.
