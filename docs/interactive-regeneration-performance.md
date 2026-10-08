# Interactive regeneration qualification, 2026-10-08

W01/W02 investigation covers OpenZCAD's real edit path and the Remus kernel it
consumes. The implementation retains independent primitive results through
audited mixed feature histories and lets pending worker messages supersede
regeneration between exact operations. It preserves modeling tolerances,
validation, display/export deflections and geometry acceptance.

## Pipeline and demonstrated waste

1. React applies a dimension, parameter or feature command through the document
   command manager. Applied feature edits first validate an exact candidate;
   the committed document then broadcasts a live sync. Undo/redo restore
   canonical document inputs. Sketch edits
   first request a separate GCS solve and apply solved coordinates in the same
   transaction. `gcs-sketch.ts` creates a fresh Remus sketch, adds entities and
   constraints, solves, and reads positions, DOF and residuals. Remus GCS uses
   component-wise DogLeg solving with a sparse path. Normal solid
   regeneration does not rerun the constraint solver.
2. `useGeometryWorker` posts the project document to the geometry worker. The
   wire helper omits edit history and packs imported meshes as typed arrays;
   prior derived topology and display data still travel in the request. Its
   queue serializes jobs, coalesces queued broadcasts, preserves explicit
   requests, and rejects publication from superseded broadcast generations.
   `ExactRebuildCache` keys complete modeling content plus analysis and lineage
   demand, excluding derived output and undo/version bookkeeping. Cache values
   own their buffers; returned mesh buffers are transferred to the UI.
3. The exact adapter resolves parameter dependencies and sketch attachments,
   compares feature digests, and selects the longest valid retained history
   prefix. History is ordered replay with explicit body/sketch references,
   rather than a general execution DAG. Sparse checkpoints preserve exact
   arena state; restore retires descendants. First mutation of shared kernel
   topology can copy arena storage.
4. Feature builders call the paired Rust Remus BRep WASM kernel. Analytic/NURBS
   curves and surfaces, exact operations, topology witnesses, lineage,
   tolerances and typed refusals remain authoritative. Dependent builders read
   this run's shapes and consumed-body state.
5. Per-body measurement proves handle identity and validation before reuse.
   Changed bodies obtain topology, bounds, volume and tessellation. Optional
   mass properties are queried on demand. Remus already caches reusable face
   meshes and face integrals; grouped tessellation still prepares shared
   boundaries and reconciles/welds the whole changed solid. JS owns measured
   buffers independently of the kernel and returned projections.
6. `ModelViewer` installs exact meshes in Three.js/WebGL. It already compares
   per-body projections and updates/reuses render resources. Remus's standalone
   wgpu renderer is not OpenZCAD's browser rendering path. The existing holder
   draft and upstream-pattern projections are approximate, non-exportable
   display data, separate from authoritative document and export geometry.

Previously, a dependent feature anywhere in the replay suffix disabled
independent primitive reuse. Editing one early box in a 100-feature mixed
history therefore rebuilt and remeasured unrelated boxes. This was directly
observed in builder/measurement counters and stage timings. A second defect was
that synchronous replay never yielded a browser task: queued messages could
not update the cancellation gate until the obsolete history finished.

## Implementation and correctness contract

Only unchanged primitive results are reused. The audited suffix permits
primitives, sketches, extrusions, revolutions, transforms, booleans, fillets,
chamfers, patterns and direct edits. These builders preserve their input
solids; dependent operations still run in history order against current
operands. Unaudited feature kinds retain ordinary checkpoint restore/replay.
This is conservative incremental regeneration, not a complete DAG evaluator.

Existing digests continue to include feature content/order/suppression,
resolved parameter dependencies, referenced sketch objects and imported
sources. Project identity, units, parameter errors and profile mode guard
global reuse; analysis, strict-union mode, recognition and lineage guard
measurement reuse. Actual restore prunes retired primitive handles; exports
and queries retain their checkpoint cleanup. Cache hits still prove exact
face/edge/vertex handle sets and validation. Returned meshes are isolated
clones. Neither precision nor required geometric checks are reduced.

The synchronous and asynchronous replay drivers share one generator. The
worker requests a task yield after an 8 ms work quantum at feature/body
boundaries, including after the last body before publication. A synchronous
WASM operation or checkpoint remains indivisible and can exceed that quantum.
The worker queue and adapter ownership queue keep kernel jobs serial, including
direct concurrent adapter calls, exports, mass preparation and recognition.
Pending edits update the existing
cancellation/version gates; stale progress, preview and final results cannot
publish. Cancellation drops the partial result and mass epoch. Executed work
from cancelled jobs now counts toward the existing 512-builder recycling
budget. Checkpoint retention remains bounded by count, not a topology byte cap.

## Measurements

Browser profiling also found synchronous shelf-thumbnail drawing/readback
during edit sequences, and hundreds of status messages for a short build.
Background capture now waits for four seconds of actual input inactivity and
for exact work to finish, rechecks its staged version before drawing, and
keeps leave-time flush behavior. Worker status is sampled at 50 ms intervals
with immediate stage transitions and terminal messages; the adapter still
reports every stage. These are scheduling changes, not geometry shortcuts.

The final browser workload uses distinct widths (12.0–14.9 mm) so the
whole-document cache cannot replace regeneration with a repeated-result hit.
Separate repeated-value and fully visible multi-body traces characterize
cache behavior and rendering limits. An isolated-part variant keeps all
100 history bodies in exact regeneration while rendering only the edited
source and newly created box; visibility is an explicit document input.

### Method and adapter results

Baseline is OpenZCAD `23e893da9e3fc0de747ac68def0c138fefe57321`. Both variants
use the installed paired Remus 2026.1.42 artifacts from `edd3fed4223396f9d066dff3a2dfaeb1b0250c1a`;
no kernel pin or compiler configuration changed. The host is Linux 6.18.44,
AMD EPYC 9V74, Node 24.19.0 and Chromium 151.0.7922.173. Browser rendering uses
ANGLE/SwiftShader software Vulkan at 1440 × 1000, DPR 1. These are cloud-host
measurements, not a desktop GPU or macOS qualification.

Runs are sequential, without concurrent builds/tests. Each warm case has 30
samples; median and p95 use nearest rank. Cold adapter runs start with an empty
history after WASM loading, excluding download/compile/instantiate. Cold values
per adapter/import model are single observations, not tail estimates. One
before/after pair cannot establish small differences as stable improvements.

Early dimension edits in 100-feature histories, adapter milliseconds:

| Downstream family | Before median / p95 | After median / p95 |
| --- | ---: | ---: |
| Extrusion | 93.73 / 132.47 | 31.40 / 38.66 |
| Boolean | 99.38 / 106.75 | 34.31 / 44.77 |
| Fillet | 96.63 / 116.32 | 35.65 / 45.85 |
| Chamfer | 93.03 / 111.58 | 30.66 / 35.31 |
| Pattern | 100.65 / 117.16 | 35.77 / 49.94 |
| Direct edit | 99.17 / 128.08 | 30.55 / 38.76 |
| Pure primitive parameter history | 27.81 / 32.78 | 29.96 / 37.86 |

Mixed-history medians improve by 63–69%. The pure-primitive case already had
incremental reuse and measured 8% slower at median, 15% at p95 in this pair;
there is no demonstrated improvement for that case. The implementation adds
generator/scheduling ownership bookkeeping; run-to-run variability also remains.
All 1,260 warm edits in each variant match fresh regeneration. Complete 30/100
feature results, cold observations, operation/early/late edits and counters are
retained in the linked evidence below.

For the extrusion case, history time fell from 21.35 to 3.05 ms median and
measurement from 71.42 to 26.59 ms. Builders executed: 100 → 3; primitive
results reused: 0 → 97; bodies remeasured: 99 → 2. All remaining bodies still
undergo the existing reuse proofs. These counters substantiate the speedup;
measurement remains linear in model size.

Additional exact workloads, milliseconds (30 warm edits):

| Workload | Before median / p95 | After median / p95 | Cold before / after, one observation |
| --- | ---: | ---: | ---: |
| Constrained circle radius → cylinder, 2 features | 4.48 / 9.39 | 4.27 / 9.56 | 64.12 / 61.38 |
| Same solved sketch with 98 independent boxes, 100 features | 102.14 / 122.00 | 31.18 / 34.38 | 159.19 / 189.64 |
| Offset face on imported holder, 160 faces / 42 NURBS | 1323.90 / 1435.79 | 1365.05 / 1453.73 | 5159.80 / 5010.88 |

The 100-feature sketch case improves 69% at median. Its solver is already fast:
0.26 → 0.25 ms median; exact regeneration falls 99.45 → 28.50 ms. All 60 sketch
edits per variant, plus their cold samples, match complete fresh geometry/meshes;
constraint residuals are zero. This does not characterize a large constrained
sketch. The imported holder demonstrates no speedup, with a 3% slower warm
median in this pair. Cold cases still build everything; the change targets edits.

### Browser latency and blocking

Actual Apply clicks through the real worker, body installation and next
render-loop marker, milliseconds (30 distinct edits):

| View | Before median / p95 | After median / p95 |
| --- | ---: | ---: |
| Simple box | 164.20 / 313.80 | 168.10 / 329.90 |
| 100-feature history, isolated edited part | 695.30 / 791.60 | 594.30 / 716.30 |

The isolated-part case improves 15% at median and 10% at p95. Common edits do
**not** meet the roughly 100 ms screen-feedback target on this software renderer.
Every result has the requested actual body width and no warnings/runtime errors.
The marker observes the render loop, not GPU completion or physical presentation.

The 100-feature median stages are click → final live-sync request
280.10 → 184.60 ms (includes validated preflight and commit), live request →
response observed on the main thread 238.70 → 216.80 ms, response → installed
bodies 184.00 → 192.70 ms, and installation itself 3.20 → 3.40 ms. The request
roundtrip includes message delivery delayed by rendering; it is not a kernel
timer. Stage medians need not sum to the median total. Run-wide worker state
messages fall 52,007 → 523 through reuse and UI progress sampling.

Main-thread long tasks still overlap all 30 edits in each case. In the
100-feature view the overlapping time per edit is 349.90 → 347.70 ms median,
406.30 → 417.40 ms p95; the worst overlapping task is 261 → 248 ms. Simple-box
overlap is 121.30 → 128.50 ms median. Rendering/UI blocking is not eliminated.

Six fresh Chromium workers per variant provide a separate cold simple-creation
sample: click → frame 284.10 / 322.20 ms before and 277.70 / 299.00 ms after
(median / p95). With six samples p95 is the maximum, only descriptive. Observed
`loading-remus` → `rebuilding` spans are 43.30 / 96.40 → 52.10 / 60.80 ms;
these include main-thread delivery delay, not isolated compile/instantiate time.
The initial creation in the 100-feature view was 383.40 → 398.30 ms, after its
seeded history had loaded; it is not a cold kernel measurement.

Exploratory five-edit traces with all 100 overlapping bodies visible measured
about 2.8 seconds at median. They preceded the final progress sampler and are
separate from the final comparison. A main-thread CPU profile of that baseline
was dominated by native browser work; synchronous `toDataURL` readback accounted
for about 0.98 seconds over the trace. Profiling was excluded from timed runs.

The [raw timing CSV](performance/interactive-regeneration-2026-10-08.csv) and
[summary/provenance JSON](performance/interactive-regeneration-2026-10-08.json)
retain the complete matrix, stage/counter evidence, cold samples and browser
blocking statistics. Large raw document/progress streams remain local. Both
installed WASM hashes match across variants; candidate source hashes identify
the measured implementation over the baseline commit.

### Remaining bottlenecks and concrete next work

The holder's final warm median spends 490.77 ms in `recognizeFeatures`, 392.06 ms
in `solidEdgeRelations`, 81.76 ms in grouped tessellation, 102.02 ms in volume,
and 54.64 ms in the journaled face move. About two thirds of the latency is
recognition/edge classification. Display mesh plus face-topology measurement
also includes area, witnesses and blend classification beyond tessellation.
`kernelMs` measures synchronous SDK entrypoints including boundary overhead;
the remainder can include translator work during import, not just JavaScript.

1. Profile and share the Remus edge-classification context across recognition
   and edge-relation queries. Preserve their distinct probe/deflection settings,
   topology lifetime and refusal behavior in a combined or correctly keyed API.
   Removing both required queries or reusing recognition after arbitrary edits
   would change behavior and is not justified by this evidence.
2. Yield between measurement sub-stages, then add bounded/cancellable kernel
   work where supported. Today one 490 ms kernel call and the whole body
   measurement are indivisible; an obsolete job cannot observe new messages
   inside them. The 8 ms scheduler quantum is a soft boundary, not a deadline.
3. Run the same browser probe on a real target GPU before viewport changes.
   Measure native frame/draw timing and label/layout work; the fully visible
   multi-body view also needs cross-body resource/draw batching. Per-body edge
   batching and render-resource reuse already exist. Move thumbnail drawing
   and readback off the UI thread if quiet-time capture still blocks new input.
4. Extend the ordered history evaluator with dependency-aware scheduling and
   reuse for audited dependent results, plus topology byte accounting. Profile
   canonical/derived request cloning and reduce unused wire data: the first
   100-feature request here contains about 1.24 MB of prior derived data in
   addition to about 0.11 MB of modeling nodes. No clone-only saving is claimed.

No kernel replacement, additional threads or lower-accuracy shortcut is proposed
as a measured solution. Existing native Remus profiling confirms face-mesh reuse
can preserve exact output (holder warm tessellation about 78 ms versus 518–577 ms
with reuse disabled, no boundary/nonmanifold edges, coordinate deviation
1.42e-14); that is an already-available facility on a different native source
revision, not an additional OpenZCAD before/after gain.

## Verification and limitations

The required repository gates passed: lint (18 existing warnings, no errors),
typecheck, 4,001 root tests, 2,070 web tests, 182 parity tests and `pnpm build`,
including paired-Remus verification and the unchanged bundle-size gate. The
kernel's existing size-review warning remains; there are no budget failures.
Background thumbnail coordination loads behind a separate module boundary;
staging, unsubscribe and leave-time flush across that boundary are tested.

Both adapter variants check every warm edited output against a fresh adapter
with checkpointing disabled, including topology, witnesses, references,
recognition, lineage, bounds, volume and warnings. This existing matrix compares
mesh triangle counts. The focused mixed parameter/transform/boolean regression
and the constrained-sketch probe also compare complete published mesh arrays.
The imported model checks all exact topology fields, STEP DATA and STL at a
common 0.08 mm deflection. Warm display triangulation can differ legitimately:
the existing display policy holds the prior deflection for small size changes.
Only display triangle ranges are excluded from the exact-topology comparison;
exports are compared byte for byte. That policy and export settings are unchanged.

Existing regressions exercise sketch objects, transitive parameters, units,
project identity, imported-source and analysis changes, order, suppression,
undo/redo, export restores, checkpoint ownership and retired handles. New tests
deliver real tasks during history, measurement and after the final body, ensure
obsolete jobs cannot publish derived state or live mass epochs, and count
cancelled work toward recycling. Concurrent sync/export/mass/recognition jobs
serialize their arena ownership. Memo scopes close before every yield, including
when a separate adapter runs in the same JavaScript realm.

These changes do not implement a complete dependency-graph evaluator. Audited
dependent builders still replay even if they are unrelated to an edit. Cache
proofs, cloning and per-body render comparisons still visit the whole model.
Count and replay-work limits do not bound retained topology bytes; actual
worker-heap and native desktop-GPU qualification remain open W01/W02 work.
The local browser probes exercise the real edit flow; the complete browser CI
matrix and hosted/desktop verification are separate from these local results.

## Reproduction

Use a quiet machine, frozen dependencies and separate source checkouts. Both
variants must resolve the same paired WASM artifacts. Run baseline, then
candidate, with unique output names because JSONL appends:

```sh
pnpm install --frozen-lockfile
CAD_PERF_RUN=1 CAD_PERF_HISTORY=30,100 CAD_PERF_SAMPLES=30 \
  CAD_PERF_MODE=baseline CAD_PERF_BASELINE_ROOT=/path/to/baseline \
  CAD_PERF_SESSION=baseline pnpm exec vitest run --config test/perf/cad-operations.config.ts
CAD_PERF_RUN=1 CAD_PERF_HISTORY=30,100 CAD_PERF_SAMPLES=30 \
  CAD_PERF_SESSION=candidate pnpm exec vitest run --config test/perf/cad-operations.config.ts
CAD_PERF_RUN=1 CAD_PERF_SAMPLES=30 CAD_PERF_SKETCH_OUT=sketch.jsonl \
  pnpm exec vitest run --config test/perf/sketch-edit.config.ts
OFFSET_PERF_STEP=/path/to/remus/crates/io/tests/data/shapr3d_hammer_holder.step \
  OFFSET_PERF_AREA=1045.93 OFFSET_PERF_FULL=1 OFFSET_PERF_SAMPLES=30 \
  OFFSET_PERF_OUT=complex.jsonl \
  pnpm exec vitest run --config test/perf/offset-face-perf.config.ts
OZ_PERF=1 CAD_PERF_BROWSER_SAMPLES=30 CAD_PERF_BROWSER_HISTORY=100 \
  CAD_PERF_BROWSER_ISOLATE=1 CAD_PERF_BROWSER_EDIT_MODE=unique \
  CAD_PERF_BROWSER_OUT=browser.json pnpm exec playwright test perf-cad-edit
```

Set `CAD_PERF_MODE=baseline CAD_PERF_BASELINE_ROOT` for the sketch comparison;
the offset config needs only `CAD_PERF_BASELINE_ROOT`. For browser comparisons,
serve a production build from each source root at the same base URL, using the
same Chromium binary/viewport/launch arguments. `CAD_PERF_BROWSER_SOURCE_ROOT`
records provenance for that served source. Omit the history override for a
simple box. `CAD_PERF_BROWSER_PROFILE=1` attaches a main-thread CPU profile;
profiled samples should be kept separate from latency comparisons. The public
STEP fixture stays in Remus and is not duplicated here.

For cold creation samples, run the simple-box probe with
`CAD_PERF_BROWSER_SAMPLES=5 --repeat-each=5` in each variant, then include the
initial creation from its 30-edit run. Each repeat gets a distinct Playwright
worker/browser. Extract the attached `cad-edit-performance.json` records from
the JSON reporter; an explicitly named `CAD_PERF_BROWSER_OUT` is overwritten by
each repeat, so use attachments for the six-sample cold aggregate.
