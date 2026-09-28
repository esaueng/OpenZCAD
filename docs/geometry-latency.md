# Geometry latency improvements

This change removes redundant work from four measured paths:

- A primitive-only affected suffix can retain unchanged exact primitive results
  and their measured meshes. A 100-feature parameter edit executes one builder
  and remeasures one body instead of 98. Suffixes containing dependent features
  keep the existing prefix restore/replay policy.
- Optional center-of-mass and inertia integration runs when the Inspector's mass
  section is opened. Area, volume and validation still run during normal sync.
  The existing single-solid, 64-face query limit remains. Epoch and document
  checks prevent stale handles; cached undo and export recovery rebuild exact
  history without running another mesh/area pass. Text fonts preload on recovery.
- Accepted union closure-check meshes can supply the same sync's display pass.
  Copies are JS-owned, keyed by kernel/solid/tessellation settings, consumed once
  and capped at 8 MiB total. Allocation or budget failure falls back to normal
  tessellation without changing the union verdict. Validation remains intact.
- Remus 2026.1.4 computes curved face area without discarded positional moments.
  Quadrature, trim domain and errors are unchanged. The native area getter's
  Criterion estimate is 1.9670 → 0.79225 ms on a representative fillet face;
  this alone is not a whole-operation speedup claim.

The primitive cache is tied to one history-kernel lifetime and is pruned on
actual restores. Project/unit changes, failures and disposal invalidate it.
The existing 512-executed-feature replay-work recycle still bounds repeated
arena growth, and reused primitives do not allocate new topology. This is not
an arena byte limit or a general feature dependency graph. See
[history cache retention](history-cache-retention.md).

## Measured adapter results

Sequential runs used seven alternating edited samples per operation family,
30/100-feature histories, Node 24.14.0 and an AMD Ryzen 9 5900XT on Linux x86_64.
No other work from this task ran concurrently with the measured samples; other
geometry jobs were active on the shared host. Small differences are noise-sensitive.

The baseline is OpenZCAD `24f1d66e` with Remus `fe3c8efa` (2026.1.3). The
candidate is OpenZCAD `7c7d75bd` with Remus `96acaccf` (2026.1.4). This compares
the combined changes; it does not isolate each optimization's contribution.
The [provenance](performance/geometry-latency-2026-09-28.provenance.json)
records full source identities and installed binary hashes. The harness's
identity lookup was corrected to resolve the package from its declaring
workspace package after a strict pnpm install; fixtures and measurement
boundaries are unchanged.

| Operation edit | 30 features, median ms before → after | 100 features, median ms before → after |
| --- | ---: | ---: |
| Extrude | 2.983 → 3.176 | 14.525 → 15.380 |
| Boolean | 7.566 → 8.136 | 17.982 → 18.540 |
| Fillet | 32.212 → 19.343 | 43.618 → 30.213 |
| Chamfer | 3.257 → 3.239 | 14.473 → 14.536 |
| Pattern | 4.288 → 4.460 | 15.888 → 15.713 |
| Parameter | 23.286 → 1.380 | 79.652 → 2.281 |
| Direct edit | 2.792 → 2.817 | 14.935 → 13.800 |

The strongest measured gains are the parameter fixture (about 94–97% lower)
and fillet fixture (about 31–40% lower). This run does not establish meaningful
improvement for the other families. An operation can still spend most of its
time rebuilding a dependent suffix or inside the Boolean kernel.

Every edited sample was compared with a fresh adapter: **588/588 comparisons
passed**, with no warnings. The oracle compares normalized derived topology,
references, geometry metadata, bounds, measurements and mesh triangle counts;
it omits timestamp, mesh layout and the rebuild-local blend label. Optional
mass properties are verified by separate closed-form/query regressions.

[All phase summaries](performance/geometry-latency-2026-09-28.csv) include
early/late edits and nearest-rank p95; with seven samples, p95 is the sample
maximum, not a reliable tail-latency estimate. [Raw warm samples](performance/geometry-latency-2026-09-28.samples.csv)
retain work counters. Full progress streams remain local benchmark artifacts.

The boundary is `syncDocument`, excluding worker serialization, UI scheduling,
GPU work and physical presentation. These figures do not promise instant
operations on arbitrary models or constrained devices. The existing
[benchmark instructions](cad-operation-performance.md) reproduce the matrix
with `CAD_PERF_HISTORY=30,100 CAD_PERF_SAMPLES=7`.
