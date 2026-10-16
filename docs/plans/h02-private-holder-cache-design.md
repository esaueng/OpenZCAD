# H02 private-holder latency cache design

**Status:** partial implementation: the existing unchanged measurement cache
is hardened; the proposed text-branch replay record remains blocked. See
[implementation evidence](../qa/2026-09-29/h02-cache-safety.md).

H02's named trace leaves two costs after the existing exact-history prefix
restore: about 5.7 s of suffix replay (about 3.6 s in the growing-holder
union and about 2.1 s in an unchanged text/planar-emboss branch), followed by
about 6.1 s of body measurement. Planar edit proofs are already 0 ms in this
trace. This design describes the smallest cache additions worth benchmarking;
it does not defer recognition or validation and it does not treat a preview as
an exact result.

## Existing safety boundary

`ExactHistoryCache` checkpoints and the per-body `MeasuredBodyCacheEntry` share
one long-lived kernel. A checkpoint is valid only in that kernel's arena.
Handles allocated before a checkpoint must remain valid after restore; handles
allocated after restore are retired and must never be reused for another
entity. Until W02 pins that behavior as a versioned Remus contract, a failed
restore or failed handle probe drops the whole cache and rebuilds from an
empty kernel.

The existing body measurement cache remains the source of truth for a body
measurement. The proposed branch cache may only return an immutable replay
state or a measurement payload that has passed the same validation gates; it
may not bypass `validateSolid`, strict union checks, imported-feature
recognition, or topology/lineage publication.

## Proposed cache records

### Immutable text-branch replay record

Add a worker-local record for a completed feature interval whose output is
known to be unchanged across the edit:

```text
TextBranchKey = {
  kernelPin, units, bezierProfileEdges,
  upstreamCheckpointDigest,
  upstreamShapeWitness,          // stable solid/face/edge lineage witness
  featureIntervalDigest,         // canonical feature + referenced sketches/scope
  sourceBytesDigest,             // only when the interval reads an imported source
  textSemanticsVersion
}
TextBranchValue = {
  checkpointId,
  postIntervalBuildState,
  outputShapeWitness,
  exactValidationWitness,
  estimatedBytes
}
```

The key must include every canonical input read by the interval. In
particular, a text feature is not identified by its label, profile count, or
body ID. A changed sketch object, parameter expression, source bytes, units,
profile conversion mode, or upstream lineage witness is a miss. A branch is
eligible only when its feature interval is immutable by dependency analysis:
no feature in the interval reads the edited parameter, changed sketch,
changed source, or a mutable external scope value. Unknown dependency means
miss.

The value is usable only while its checkpoint and all kernel handles remain in
the same live history kernel and the kernel pin matches. Restore must succeed,
the output witness must recount successfully, and the exact validation result
must still agree. Any invalid handle, witness mismatch, restore error, failed
validation, or cache-table/checkpoint disagreement clears this record and the
whole history cache. No nearest-face, traversal-order, hash-only, or display
mesh substitution is permitted.

This record is intended to remove replay of an unchanged text/planar-emboss
interval after a growing-holder edit. It must not be persisted in the project,
cross a worker restart, or be reused by export, preview, or another kernel.

### Unchanged measurement payload record

Retain the existing `MeasuredBodyCacheEntry` contract and make any extension
explicitly keyed by the complete measurement mode:

```text
MeasurementKey = {
  kernelPin, bodyId, solidHandleWitness,
  faceHandleCount, strictUnion,
  includeMassProperties, recognizeImportedFeatures,
  analysisKey, measurementSemanticsVersion
}
```

`solidHandleWitness` is valid only in the owning history kernel. The value is
the structured-cloned measured payload plus its exact-validation and
provenance fields; warnings, names, colors, and body wrappers remain derived
per sync. A body with a new solid handle, changed face count, changed mode,
changed analysis selection, changed imported-source provenance, or uncertain
handle lifetime is a miss. In particular, a growing-holder union result must
not reuse the old payload merely because its body ID is stable.

## Invalidation and lifetime

Invalidate both records on kernel termination, Remus pin change, units or
Bezier mode change, scope-error change, failed restore, failed handle recount,
checkpoint eviction, feature suppression/order changes, source-byte change,
or any operation that can mutate or retire an arena entity. Evict branch
records before their checkpoint is discarded. Keep the current documented
limits as the initial ceiling: at most 32 history checkpoints, 32 MiB for
derived rebuild keys/results, and the existing measured-shape byte budget.
The branch records must have their own accounted-byte cap (suggested initial
ceiling: 8 MiB, subject to measurement) and count toward the same worker
retention review; a single oversized value is never cached.

## Acceptance benchmark before implementation

Use the private holder locally and retain the H02 production harness. Compare
matched runs with the cache disabled and enabled, reporting median and p95 for
each stage: suffix replay, growing-holder union, text branch, body measurement,
and total exact completion. Also record cache hit/miss reason, replayed and
restored feature counts, measured and reused bodies, document bytes, body/face
counts, and worker retained heap where available.

The design is accepted for implementation only if all of the following hold:

1. Exact output, validation, warnings, topology/lineage witnesses, and
   measurement provenance are byte/structure equivalent on hit and miss.
2. The text branch has zero false hits across parameter, sketch, unit, source,
   suppression/order, and kernel-restart mutation cases; unknown cases miss.
3. The unchanged measurement payload has zero false hits across handle,
   face-count, strictness, mass-property, recognition, and analysis-key
   changes; stale-handle probes fail closed.
4. On the private-holder trace, the p95 total exact completion improves by at
   least 20% with the cache enabled, without increasing retained heap beyond
   the proposed 8 MiB branch cap plus the existing limits.
5. A long-session run covering checkpoint eviction, repeated edits, worker
   termination, and rebuild after refusal leaves no live handle from an
   evicted or retired checkpoint reachable by a later cache hit.

Until these measurements and W02's pinned handle contract exist, the current
cache behavior remains the required implementation and this document is not a
performance claim.

## Implementation boundary (2026-09-29)

The inspected pair is Remus `594cd308eba3632f9a320c88c8bbb7b41a68bb45`.
Its checkpoint API restores ancestors and permanently retires later handles;
it cannot restore a detached old Text branch while retaining a newly replayed
holder. The prefix contract is covered against the installed WASM in
`test/h02-measurement-cache.test.ts`. No branch record, cross-kernel shape
substitution, or extension of primitive-only reuse to Text is enabled.
Independent interval dependency/effect analysis and a kernel operation that
preserves both branches are still required before that record is usable.
Current newly compiled recipes already put the fixed Text import before the
edited holder suffix. The remaining `Keep text together` transform reads the
opening/height parameters through `textMove(recipe)` and is therefore not an
immutable interval across those edits. Existing saved histories are not
rewritten to manufacture cache eligibility.

The existing measurement cache remains adapter-local in one live history
kernel. Kernel identity and the loaded code/pin are implicit lifetime keys:
records never cross disposal, restart, or a module update. The key includes
solid handles, analysis selection, strictness, imported recognition mode,
exact lineage and import diagnostics. Units, scope errors, source content and
Bezier mode remain guarded by the existing history digests. Mass properties
are queried separately under the current build epoch and never retained in
this payload, so there is no mass-mode payload to reuse.

Payload retention and hits use structured clones. Exact face/edge/vertex
handle sets and relaxed/strict validation verdicts are recounted on hits.
Ownership/probe disagreement clears all arena-bound owners before an exact
rebuild; recovery retries at most once. Unsuccessful measurements and values
over the existing budget are not retained. Byte estimates now include
metadata, provenance and handle records as well as mesh buffers, and are not
claims about actual worker heap. The unchanged 32-checkpoint, 32 MiB derived
rebuild and 128 MiB measurement ceilings do not authorize an additional branch
allocation; branch retention is zero until its contract and acceptance pass.


## Matched benchmark preparation (2026-10-15)

[Current harness and evidence](../qa/2026-10-15/h02-matched-cache-benchmark.md)
adds an opt-in production-preview comparison of the existing adapter caches,
using zero budgets in the disabled arm and unchanged defaults in the enabled
arm. Normal application builds and runtime cache behavior are unchanged.
Mode observations, pair/input identity checks, per-edit cache diagnostics,
nearest-rank median/p95 aggregation and optional post-GC Chromium geometry-worker
JS heap telemetry make the comparison reproducible without sharing the source.
Measurement timings account for the current pipeline's overlapping deferred
analysis timers rather than summing them.

The available local source passes the current-pin structural publication
oracle (17 bodies / 720 faces; zero difference paths) and the unchanged-source
byte/structure hit check. This supersedes the old publication-mismatch blocker
for this source under the oracle's documented normalization; it does not prove
raw B-rep byte equivalence. The attempted browser comparison was interrupted
under severe unrelated host load before a complete matched pair existed.
Median/p95, browser retention and the 20% target remain unmeasured in that
campaign. H02 remains Partial, and no proposed Text-branch cache is accepted.
