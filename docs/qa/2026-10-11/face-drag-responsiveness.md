# Face-edit preview responsiveness, 2026-10-11

H02 / W02 qualification for exact offset/radius previews, stacked on
[OpenZCAD #624](https://github.com/esaueng/OpenZCAD/pull/624). The implementation
contract is in the
[edit-to-frame plan](../../plans/edit-pipeline-performance.md#geometry-only-face-drag-previews).
Three same-kernel browser runs show the first changed exact preview at a
630.0 ms median, versus 2230.1 ms on the baseline. Complete analysis moves to
Apply, which takes 2099.8 ms to a committed frame instead of reusing an already
completed preview in 23.4 ms. This improves earlier feedback; it does not make
the full edit near real time. The final combined `2026.1.52` build records
576.9 ms to the first preview and 1454.6 ms from Apply to the committed frame,
with package identity and separate three-run results below.

## Scope and correctness contract

The #624 base adds a dedicated `previewGeometry` adapter/worker request for face
offset and cylinder-radius interaction. It runs the exact builder, display
tessellation, picking topology and existing validation gates, and returns an
owned, ephemeral `GeometryReadyState`. It omits optional volume, mass properties
and imported-feature analysis. Builder safety checks still execute any geometry
queries they need. Modeling tolerances, display deflection and acceptance rules
are unchanged.

The follow-up addresses work scheduling and redundant topology queries:

- Geometry previews start without using the previous full-analysis duration as
  a delay prediction. During continuous input, one frame can finish while only
  the newest pending value is retained. Starts are spaced by at least 100 ms;
  an individual exact build may take longer. Each pointer update does not abort
  the running geometry frame. Release, cancel and source invalidation still
  fence obsolete results.
- Within one gesture, returning to the still-live running value or one completed
  exact frame avoids a duplicate rebuild. The cache retains at most one
  completed frame, clears on stop/cancel, checks source currency, and cannot
  revive an aborted request or publish an older completion over a newer frame.
- Tangent planar-neighbour discovery uses the existing per-solid edge incidence
  memo to restrict candidates. It preserves the solid's original face order
  and all exact plane, shared-edge and tangency checks. Outside the synchronous
  memo scope, the original exhaustive traversal remains available. This adds
  no persistent topology or checkpoint cache.
- A regression transfers and detaches a published geometry mesh, then verifies
  that full analysis and the later measured-shape cache still own live arrays.
- Exact cylinder readers share the same fail-closed parameter checks, and
  pure iteration/query paths avoid duplicating typed arrays already owned by
  JavaScript. Generated binding getters copy their results out of WASM memory
  before returning, so nested kernel calls cannot detach these iterators.

The displayed preview is explicitly pending. Measurements and proof-dependent
actions cannot read base-body quantities as though they described this frame.
A geometry-only result is never stored as completed derived state and cannot
satisfy a commit or export. Apply/release requests a complete exact `syncOnce`
result, including required quantities and recognition, before committing one
undoable command. Preview candidate feature IDs may be retained; the final
completed result remains authoritative. Existing full blend/extrude previews
keep their separate complete-result reuse contract.

## Comparison and provenance

The application comparison uses the same public
`crates/io/tests/data/shapr3d_hammer_holder.step` fixture from Remus: one body,
160 faces, including 42 NURBS faces, with bounds 74 × 53 × 58 mm. The selected
outer +X planar face has area 1045.930732 mm²; the edit is −6 mm. This is a
redistributable related fixture. The reported edited model has bounds
144 × 87 × 70 mm, so these results do not establish its actual edit latency.

| Variant                    | Source                                                                                        | Kernel package identity                                              | Purpose                                                                |
| -------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Application baseline       | OpenZCAD `569cebfd9398a6b1910e666f96ccedccb23acc14`                                           | Paired Remus `2026.1.45`, `a04b5c8689f5dd12b22f1b6246921779ff10abb6` | Previous complete-sync face preview                                    |
| Application candidate      | OpenZCAD `a90f51ad59a4328c2824616262027da0bd28ff42` (after #624 merge), plus this follow-up   | Same immutable paired `2026.1.45` pin                                | Isolate application scheduling and query changes                       |
| Separate kernel comparison | Remus `8af9a73837bb74e4bce309cfec51244ecc5a5da5` → `c2cd99d0e718cc6e793eb50979ec4709fb8fedd5` | Locally compiled pair `2026.1.46` → paired `2026.1.52`               | Isolate kernel changes; do not combine with the application comparison |
| Final combined candidate   | OpenZCAD `2c72ae5bda7efd9b3454edd60c2cb9286759b4f2`                                           | Paired Remus `2026.1.52`, `c2cd99d0e718cc6e793eb50979ec4709fb8fedd5` | Qualify application changes with the final adopted kernel              |

The same-pin runs used Linux x86_64, an AMD Ryzen 9 5900XT (16 cores / 32
threads), Node v24.14.0, and headless Chromium 153.0.8010.12 at 1440 × 1000,
device scale 1. The GPU renderer was not independently recorded. The public
fixture SHA-256 is
`2403b4c9868cbb56292a09ec2f2d37baca16cc4b789d11e97ff8df3f1e46bef8`.
Both application variants use the same immutable kernel pair; the repository's
paired-WASM provenance values are `137652ccf4120105e8e89a8e089044e5324b8788`
(kernel) and `b97f2fda619b5b8c5cee04e3ed30c9bb1b22830a` (IO).

Adapter runs were serial, before/after for each of three process pairs, with
CPU affinity 0. Browser runs were three baseline runs followed by three
candidate runs, one browser test worker. These runs shared the host with
unrelated builds/tests: they are not quiet or exclusive-hardware measurements.
They control fixture, probe, kernel pin and application workload, without
isolating ambient contention or establishing a target-device latency budget.
The separate native timings taken under earlier mixed load are excluded.

Raw JSONL is stored beside this report. Browser sample fields were recalculated
from retained request/action timestamps using the corrected frame-completion
attribution; the original local captures were preserved. Each artifact includes
the original capture's SHA-256. Final combined `2026.1.52` and kernel-only
evidence remain separate from this completed same-pin comparison.

Candidate source SHA-256 values recorded after the same-pin runs, before
delivery-package adoption:

| Production source                                | SHA-256                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------ |
| `apps/web/src/App.tsx`                           | `ef557329c47d8ef25e6e671d9035b1e463eb79f9586fea797afbd0ff94e60efe` |
| `apps/web/src/lib/livePreview.ts`                | `4f9174802c827e9dff278a87a15b4bb681e397dce509d8be1db7ecfaece1a463` |
| `packages/kernel-adapter/src/exact-brep.ts`      | `5f09d6ec3035d9c50590acb53f2b6ead51310c93189148f1609650295dbbfaf1` |
| `packages/kernel-adapter/src/exact-sync-memo.ts` | `12a6886b8ca2f4514a594c123864ec480069ac52d742c0e4a6637660cb7e7ac8` |

## Browser observation

`test/e2e/perf-face-drag.spec.ts` drives the real STEP import, face picker and
Offset editor. It uses a typed exact-offset preview, which reaches the same
preview builder as dragging without camera or grid-snap variation. Label this
input mode separately from any sustained physical-pointer regression.

The probe records worker request types and timestamps, accepted output warnings,
mesh byte signatures and actual world bounds from the viewer's render policy.
Its first changed frame must follow an accepted, warning-free edited mesh and
changed rendered bounds. The observation ends after `renderer.render`; it does
not measure physical display presentation. It records completion separately
from the frame and records whether Apply reused an already completed legacy
preview or awaited its own full request.

The probe asserts full-result mesh, bounds and positive volume, parity of final
display with the accepted preview, one committed command, exact baseline
publication restoration on Undo, and no runtime errors. These checks cover the
published geometry; raw serialized B-rep equivalence across versions is a
separate qualification. Timing values never gate CI.

Times are milliseconds, median (minimum–maximum), with three runs per variant.
No p95 is estimated from three samples.

| Browser metric                          |               Baseline |                 Candidate | Samples / limits                                                |
| --------------------------------------- | ---------------------: | ------------------------: | --------------------------------------------------------------- |
| Input → worker preview request          |    333.3 (325.6–334.1) |          20.1 (19.6–20.3) | Includes input scheduling                                       |
| Input → first changed rendered preview  | 2230.1 (2205.9–2231.2) |       630.0 (611.3–680.2) | Matched typed-offset inputs                                     |
| Input → complete preview analysis       | 1980.3 (1978.7–1996.7) |                   Omitted | Geometry-only preview has no completed analysis                 |
| Apply → remaining complete result       |          0.0 (0.0–0.0) |    1864.6 (1692.7–1874.0) | Baseline adopts its completed preview                           |
| Apply → committed rendered frame        |       23.4 (22.6–24.3) |    2099.8 (1918.7–2106.6) | Candidate requires full exact completion                        |
| Baseline post-commit refresh completion |    251.9 (248.5–252.1) | Not attributed separately | Baseline's later sync did not provide its first committed frame |
| Undo → restored rendered frame          |    416.5 (407.2–439.1) |       442.4 (427.2–444.1) | Restored publication parity required                            |

The observed preview median is 71.7% earlier. All baseline preview requests
were `sync`; all candidate preview requests were `preview-geometry`. Baseline
Apply's first committed frame references the completed preview request, while
its later broadcast sync is a refresh. The recalculated sample therefore says
`completionSource: "reused-preview"`, with zero remaining analysis, and reports
that refresh separately. The candidate issues a full sync on Apply before its
committed frame, followed by the normal broadcast refresh. This makes the
release cost visible instead of counting omitted analysis as a speedup.

All six runs pass geometry, Undo, warning and runtime-error assertions. The
source and restored volume is exactly 50241.713212494236 mm³; the −6 mm result is
exactly 40548.36304506951 mm³ in both variants. Preview and final mesh signatures
match within each run, and rendered bounds change from maximum x = 48 mm to
42 mm and return to 48 mm on Undo. No raw serialized B-rep equivalence or
physical-display timing is inferred.

Raw browser records:
[baseline](face-drag-browser-baseline45.jsonl),
[candidate](face-drag-browser-candidate45.jsonl).

For sustained input, deterministic scheduling tests and a real viewport
regression check that geometry can appear while input continues. They do not
establish a target-device frame rate. Record the browser regression outcome and
its input cadence separately from the typed-offset timing sample.

Reproduce against each production build with the same installed kernel pair:

```bash
OZ_PERF=1 OZ_PERF_FACE_STEP=/path/to/shapr3d_hammer_holder.step \
  OZ_PERF_FACE_AREA=1045.930732 OZ_PERF_FACE_LABEL=baseline-or-candidate \
  OZ_PERF_FACE_OUT=/path/to/face-drag-browser.jsonl \
  pnpm exec playwright test perf-face-drag --workers=1
```

## Adapter and kernel observations

`test/perf/offset-face-perf.test.ts` separates the adapter wall time from
inclusive WASM method durations and adapter stage events. Geometry-only preview
timing is distinct from complete edit and Undo timing. Method totals can include
nested calls and instrumentation adds overhead; phase traces belong in separate
diagnostic runs, not in the application comparison.

Times are milliseconds, median (minimum–maximum). Single-operation rows use
three fresh-process runs per variant; warm rows pool three samples from each
of those runs (nine observations, not nine independent processes).

| Adapter metric, same `2026.1.45` pin |               Baseline |              Candidate | Samples / limits                              |
| ------------------------------------ | ---------------------: | ---------------------: | --------------------------------------------- |
| Cold complete import                 | 6037.5 (5640.5–7189.2) | 7076.0 (5839.0–7087.6) | Three fresh processes                         |
| First −6 mm preview publication      | 1886.5 (1737.0–2120.1) |    510.1 (496.8–516.0) | Complete sync versus geometry-only            |
| Warm preview publication             | 1797.2 (1708.5–2089.3) |    433.2 (396.1–528.8) | Nine observations, same −6.2/−6.4/−6.6 inputs |
| Complete −6 mm edited sync           | 1834.1 (1812.0–1930.1) | 1972.7 (1878.1–1973.5) | Full quantities and recognition               |
| Complete −7 mm second edit           | 1767.2 (1670.1–1798.8) | 1991.3 (1879.8–2065.4) | Full quantities and recognition               |
| Undo complete sync                   | 1479.1 (1415.7–1507.6) | 1655.3 (1646.3–1739.9) | Baseline publication restored                 |
| Warm complete edited sync            | 1245.2 (1113.3–1701.1) | 1368.9 (1284.9–1402.5) | Nine alternating −6/−7 observations           |

First preview publication is 73.0% earlier in this adapter sample. Complete
import, edit and Undo medians are slower in the candidate; these runs do not
show a complete-regeneration speedup and ambient load limits causal
interpretation of those differences. Earlier feedback comes from completing
geometry before optional analysis, with quantities still absent on candidate
preview bodies.

The first preview performs one exact `moveFacesJournaled` and one grouped
tessellation in both variants. Baseline preview also calls volume, feature
recognition and edge relations once; candidate preview does not call those
optional analysis methods. Its `getFaceEdges` count falls from 3581 to 504 and
`getSolidFaces` from 135 to 14. Those counts span different amounts of analysis
and cannot be attributed solely to the adjacency change. Every timed result
has no warnings, 160 faces and 125046 triangles. Complete −6/−7 volumes and Undo
volume match across variants. All six processes pass the harness's final
fresh-build oracle for volume, bounds, exact topology and exports at fixed
accuracy; that oracle deliberately excludes display triangle ranges because
fresh and warm adapters can select different display deflections.

Raw adapter records: baseline
[run 0](face-drag-adapter45-before-0.jsonl),
[run 1](face-drag-adapter45-before-1.jsonl),
[run 2](face-drag-adapter45-before-2.jsonl); candidate
[run 0](face-drag-adapter45-after-0.jsonl),
[run 1](face-drag-adapter45-after-1.jsonl),
[run 2](face-drag-adapter45-after-2.jsonl).

```bash
OFFSET_PERF_STEP=/path/to/shapr3d_hammer_holder.step \
  OFFSET_PERF_AREA=1045.930732 OFFSET_PERF_PREVIEW=1 \
  OFFSET_PERF_FULL=1 OFFSET_PERF_SAMPLES=3 \
  OFFSET_PERF_OUT=/path/to/face-drag-adapter.jsonl \
  pnpm exec vitest run test/perf/offset-face-perf.test.ts \
  --maxWorkers=1 --reporter=verbose --silent=false
```

The measured adapter processes were launched with CPU affinity 0; the command
above is a portable reproduction without that host-specific affinity setting.

## Separate kernel comparison

The immutable [Remus qualification report](https://github.com/esaueng/remus/blob/56021163200a5beeda670a8f1ae0de2ae9ef6aee/docs/performance/face-drag-qualification-2026-10-11.md)
records package/module hashes, raw stage evidence and the native/WASM workload
distinction. Its maintained WASM harness compares locally compiled paired
`2026.1.46` at `8af9a73837bb74e4bce309cfec51244ecc5a5da5` with paired
`2026.1.52` at `c2cd99d0e718cc6e793eb50979ec4709fb8fedd5`.

| WASM kernel pipeline, milliseconds | Baseline median | Final median |
| ---------------------------------- | --------------: | -----------: |
| Geometry-first schedule            |          1108.3 |        969.0 |
| Volume-first schedule              |          1082.0 |        969.3 |

Each schedule retains 12 edits per variant. The geometry-first subtotal through
display mesh transfer falls from 123.6 to 92.7 ms; this excludes restoration,
application scheduling and rendering. Volume remains the largest stage at
about 530 ms. All 36 source/warmup/measured snapshot pairs have byte-exact
reachable arenas, Float64 volume bits, feature records, mesh positions/normals,
indices and grouping; every edit validates and has a watertight display mesh.

This comparison includes the optimizations merged in Remus #982, rather than
isolating #983's finite-reference guard. Its edit distances, display policy and
cache history differ from the application probe. It does not explain the
same-pin `.45` application change or measure browser-visible latency.

## Final combined `2026.1.52` qualification

The final runs combine the application follow-up with paired Remus
`2026.1.52` from `c2cd99d0e718cc6e793eb50979ec4709fb8fedd5`, including the
upstream face-cache promotion fix. OpenZCAD's paired-pin commit is
`3a3ca80aede981d8b31d69dcd883db14cad15ac1`, and final application source is
`2c72ae5bda7efd9b3454edd60c2cb9286759b4f2`, including the adapter allocation
cleanup and preview status fix. The source hashes above describe the earlier
same-pin comparison. The final test-only head is
`02ea802b09a46d981d9e610606a47cd917e1cc80`. Kernel delivery is tracked by
[Remus #983](https://github.com/esaueng/remus/pull/983). Installed immutable-blob
verification passes. The
repository WASM provenance values are
`655f4fb2e82100a6038c54ba0f3e33a42a7b12da` (kernel) and
`6ddc84faebc6a5763b014119e6181885f7c309f3` (IO).

Hardware, fixture, typed −6 mm input and browser dimensions remain as above.
The final browser captures record the renderer explicitly:
`ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)`.
This is a software-renderer observation, not a native desktop-GPU measurement;
it does not retroactively identify the renderer in the earlier `.45` captures.
Final benchmark jobs ran serially, with this task's builds and validation
suites held until completion. The host was not exclusively allocated. These
runs are not a matched kernel-only comparison with the earlier `.45` samples.
Times are milliseconds, median (minimum–maximum), three process/browser runs;
warm adapter rows pool nine observations from those three processes. No p95
or target-device latency budget is inferred.

| Final browser metric                   |                 Result |
| -------------------------------------- | ---------------------: |
| Input → worker preview request         |       20.2 (19.3–20.7) |
| Input → first changed rendered preview |    576.9 (570.3–577.8) |
| Apply → complete result                | 1414.6 (1372.7–1451.6) |
| Apply → committed rendered frame       | 1454.6 (1398.2–1490.5) |
| Undo → complete result                 |    213.8 (203.9–215.0) |
| Undo → restored rendered frame         |    440.4 (410.5–441.6) |

| Final adapter metric            |                 Result |
| ------------------------------- | ---------------------: |
| Cold complete import            | 5265.9 (5255.9–5293.8) |
| First −6 mm preview publication |    359.8 (347.6–371.5) |
| Warm preview publication        |    290.5 (267.2–347.9) |
| Complete −6 mm edited sync      | 1451.4 (1437.7–1465.8) |
| Complete −7 mm second edit      | 1480.7 (1467.2–1485.3) |
| Undo complete sync              | 1167.5 (1163.4–1170.3) |
| Warm complete edited sync       |    881.1 (862.0–915.5) |

All six adapter tests (two per process) and all three browser tests pass on the
final pair. Preview requests remain geometry-only; Apply still requests full
completion. There are no geometry warnings or browser runtime errors. Every
timed adapter body retains 160 faces and 125046 triangles; complete −6/−7 and
restored volumes match the same-pin results. Within each browser run, preview
and committed meshes/bounds match, and Undo restores the baseline publication.
The adapter's fresh topology, STEP data and fixed-deflection STL oracle passes.
These observations preserve the earlier preview/Apply tradeoff and do not
replace the controlled same-`.45` application comparison with a kernel-speedup
claim. They also remain measurements of the smaller public proxy fixture.

Raw final records: adapter
[run 0](face-drag-adapter52-0.jsonl),
[run 1](face-drag-adapter52-1.jsonl),
[run 2](face-drag-adapter52-2.jsonl);
[browser](face-drag-browser-candidate52.jsonl).

Adoption uses the repository's paired-pin tooling and immutable package
provenance checks. The final production build passes the unchanged bundle
budget: `exact-BxnBgZxo.js` is 511901 bytes against 512000 allowed. The installed
kernel is 10368772 bytes, below the unchanged 10 MiB hard cap; the existing
review warning remains. Final local repository validation passes after the
paired install; the earlier `2026.1.45` checks are recorded separately.

## Verification and remaining limits

Focused adapter checks pass locally: 68 tests across read memo, exact
adjacency, pierce, staged ownership, direct-edit kernel reads, measurement
cache and box/cylinder lineage suites, plus 60 section/DXF/recognition tests
after the allocation cleanup. Selected real circle/ellipse tests also pass.
The adjacency oracle compares indexed and exhaustive results on real
filleted geometry and rejects non-shared/foreign incidence candidates. Scoped
lint and final TypeScript checks pass. Full repository lint has zero errors
and 18 existing warnings. The complete unit run passes 4046 core tests and
2375 web tests, with eight existing core skips. Final parity qualification
passes 182 tests with one existing skip. The production build passes as
recorded above.

All 13 focused browser tests pass on the final test head, including continuous
pointer input, exact-frame reversal reuse, complete validation on release,
invalid/canceled offsets, Undo/Redo/reopen, suspended saved measurements and
blocked staged export/context actions. The focused web suite passes 88 tests.
These checks qualify the preview authority boundaries separately from the
three opt-in browser performance runs.

One initial full web run failed the existing async rename-focus assertion in
`ParameterRows.focus.test.tsx`; the isolated file passes all eight tests and
both the test and component match the application baseline byte for byte. No
assertion or product code was changed for that unrelated failure. The final
complete web suite passes all 2375 tests with that assertion unchanged.

Remus #983's hosted source/package and changed-kernel-version gates pass at
recording. This does not establish all hosted checks or deployment. OpenZCAD
hosted CI, merge/deployment and target-device qualification remain unverified.
A synchronous WASM call still occupies the worker until it
returns; coalescing does not make such a call preemptible. Geometry preview
publication does not remove complete analysis from release, establish a heap
ceiling, or prove near-real-time behavior for the larger reported model.
