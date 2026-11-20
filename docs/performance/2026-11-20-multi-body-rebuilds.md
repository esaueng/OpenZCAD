# Multi-body exact rebuilds

A warm size edit to the last of 100 positioned boxes produced display geometry
in 9.36 ms, down from 14.12 ms. The exact adapter now skips alternate lineage
tracking in histories with no eligible boolean. In mixed histories it reuses
the current feature digest wherever the idle request reads the same inputs.
An unchanged body's measurement still requires a fresh topology and
validation witness. Its provenance usually compares equal as plain JSON,
which avoids sorting and rebuilding every nested record. Differently ordered
members use the canonical comparison.

## Worker-path measurements

Times are milliseconds. Each cell gives the three run medians followed by
their median. Each run edited one body to 21 distinct sizes after four
warm-ups. Baseline and candidate ran in alternating order on the same
Ryzen 9 5900XT with Node 24.22.2 and Remus 2026.1.151. The baseline was
`f7d89ac65`, and the candidate implementation was `284a0999c`.

| Model and boundary | Baseline | Candidate |
| --- | --- | --- |
| 100 boxes, geometry ready | 14.30, 13.98, 14.12 → **14.12** | 9.58, 9.29, 9.36 → **9.36** |
| 100 boxes, complete packet encoded | 18.70, 18.16, 18.48 → **18.48** | 13.89, 13.22, 13.40 → **13.40** |
| 30 mixed bodies, geometry ready | 5.41, 5.52, 5.48 → **5.48** | 4.68, 4.77, 4.77 → **4.77** |
| 30 mixed bodies, complete packet encoded | 8.02, 8.17, 7.97 → **8.02** | 7.10, 7.15, 7.34 → **7.15** |

The 100 boxes have 1,200 triangles. The 30-body model includes cylinders,
spheres, boxes, tori and cones and has 599,124 triangles. The probe runs the
production adapter, rebuild cache and projection encoder in Node, with the
worker's shared-geometry size accounting. The receiver checks each early and
complete publication against independent owned measurements, including mesh
bits and topology. Timed edits use fresh inputs beyond the warm-up range.

The baseline CPU profile of 55 exact edits to the 100-box document attributed
196 ms to serializing measurement provenance and 65 ms to resolving transforms
while completing alternate lineage on reused shapes. These are accumulated
sampled CPU times for the whole series. The two entries have different call
stacks. The remaining cost on curved bodies includes the kernel's exact
bounds and tessellation work.

To repeat the worker comparison, use the same harness on both source trees
and write each run to a new directory.

```sh
MULTI_BODY_PERF_RUN=1 MULTI_BODY_PERF_SAMPLES=21 \
  MULTI_BODY_PERF_OUT=/tmp/oz-multibody-run \
  pnpm exec vitest run --config test/perf/multi-body-sync.config.ts
```

## Feature edit matrix

The exact adapter benchmark exercised seven feature families on 33- and
100-feature histories. Each cell shows the median of two run medians, in
milliseconds, with five alternating operation edits per run. Trial order was
baseline/candidate, then candidate/baseline. The adapter used its default
caller-owned results. These timings include rebuilding the surrounding
history and preparing the derived state.

| Edited feature | 33 features, before → after | 100 features, before → after |
| --- | ---: | ---: |
| Extrude | 10.6 → 8.8 | 23.9 → 20.3 |
| Boolean | 13.2 → 12.3 | 27.5 → 24.9 |
| Fillet | 9.9 → 9.0 | 25.3 → 22.5 |
| Chamfer | 8.4 → 7.4 | 24.6 → 20.9 |
| Parameter | 7.8 → 6.9 | 24.1 → 20.6 |
| Direct-edit | 8.1 → 7.2 | 23.8 → 20.2 |
| Pattern | 12.6 → 11.7 | 28.2 → 24.4 |

Across operation edits and edits early and late in history, all 840 warm
results matched the fresh-adapter oracle. The oracle compares published
geometry and measurements, normalizing mesh payloads to triangle count.
The separate multi-body comparison above checks the actual mesh bits.

Reproduce with `CAD_PERF_RUN=1 CAD_PERF_HISTORY=33,100 CAD_PERF_SAMPLES=5
pnpm exec vitest run --config test/perf/cad-operations.config.ts` on each
revision. Choose a fresh `CAD_PERF_OUT` directory for each run.

## Browser edits

Headless Chromium 156.0.8078.4 used the production renderer with ANGLE OpenGL
on an RTX 3090. Each run applied 21 distinct box widths to an isolated
visible body in a modeled history. Each pair used a fresh browser context
per build. The first pair ran baseline then candidate and the second
reversed the order. Times are medians in milliseconds for each run.

| History setting | Stage | Baseline runs | Candidate runs |
| --- | --- | ---: | ---: |
| 100 | Worker request to response | 24.8, 23.9 | 22.8, 22.3 |
| 100 | Apply to analysis ready | 25.8, 24.9 | 23.7, 23.3 |
| 100 | Apply to next rendered frame | 65.6, 65.9 | 64.9, 65.6 |
| 500 | Worker request to response | 139.8, 133.0 | 118.5, 118.3 |
| 500 | Apply to analysis ready | 144.2, 137.4 | 122.9, 122.3 |
| 500 | Apply to next rendered frame | 251.0, 245.9 | 231.5, 230.9 |

All 168 edits confirmed the requested width and reported zero warnings and
runtime errors. The smaller history showed little difference at the frame
boundary. The larger history still spent time applying the result and
drawing the next frame. The frame marker measures the browser render loop.

Run this against each checkout, then repeat with `CAD_PERF_BROWSER_HISTORY=100`.

```sh
OZ_PERF=1 OZ_PERF_ANGLE=gl CAD_PERF_BROWSER_HISTORY=500 \
  CAD_PERF_BROWSER_ISOLATE=1 CAD_PERF_BROWSER_SAMPLES=21 \
  pnpm exec playwright test test/e2e/perf-cad-edit.spec.ts --workers=1
```

## Remaining bottlenecks

The public 160-face STEP hammer holder exercises a different cost from
editing among many independent bodies. One instrumented run per build gave
2.31 s for cold import on both. On the candidate, detailed solid validation
took 686 ms, three recognition intersections took 420 ms, and volume took
331 ms. The first face offset took 594 ms, of which 343 ms was the exact
face-move operation. Two warm offsets took 329 and 380 ms against 332 and
372 ms on the baseline. Both runs passed fresh topology, STEP and
fixed-deflection STL comparisons. These single runs locate the work and
provide no evidence of a warm imported-face speedup.

The next geometry investigation is cold import validation and recognition,
followed by the exact face move. Time the native stages on the same fixture
before changing either, preserving validation diagnostics, recognized
features, topology references and export parity. For large native models,
profile the interval between the worker response and the next viewport frame.
The two costs have separate reproduction paths.

```sh
OFFSET_PERF_STEP=/path/to/remus/crates/io/tests/data/shapr3d_hammer_holder.step \
  OFFSET_PERF_AREA=1045.93 OFFSET_PERF_SAMPLES=2 \
  pnpm exec vitest run --config test/perf/offset-face-perf.config.ts
```
