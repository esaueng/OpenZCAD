# Rebuilding and navigating edge-heavy parts

A 60-tooth spur gear rebuilt in 0.94 s across two candidate sessions. The two
baseline sessions took 1.65 and 1.72 s. Most of the original cost was measuring
the finished faces. A CPU profile of three fresh builds attributed 4.31 s to
the kernel's point-in-solid calls beneath through-hole recognition.

## Exact geometry

While publishing an immutable solid, the adapter remembers one cylinder-axis
point that the kernel proved was inside material. Coaxial faces can reuse this
negative bore result at exactly the same coordinates. Other points still go to
the kernel. An open axis and both open ends are checked before the wall. A
failed radial probe ends the publication test. Accepting a through-hole still
requires material at all four bearings. A requested operation checks the full
diagnostic and keeps its specific refusal.

A fillet or chamfer now indexes exact face witnesses while carrying names
through the operation and verifies each face supporting the selected boundary
once. Ambiguous matches and different boundary closure still withhold a name.

| Exact adapter workload | Baseline session medians (ms) | Candidate session medians (ms) |
| --- | ---: | ---: |
| Cylinder, fresh build | 1.26 / 1.30 | 1.24 / 1.22 |
| 20-tooth gear, fresh build | 188 / 185 | 158 / 156 |
| 60-tooth gear, fresh build | 1,652 / 1,715 | 941 / 941 |
| 12-edge box, warm fillet | 7.39 / 11.54 | 6.67 / 6.15 |
| 12-edge box, warm chamfer | 5.12 / 5.62 | 4.13 / 3.53 |
| 486-edge collared gear, warm rim fillet | 772 / 768 | 676 / 685 |
| 486-edge collared gear, warm rim chamfer | 735 / 728 | 645 / 660 |

Runs alternated baseline, candidate, candidate, baseline on a shared Linux
Ryzen 5 5600 with 15 GiB RAM, Node 24.22.2, and the identical released Remus
WASM from `d5c7248d`. The application baseline was `5dd61dee1`. The geometry and viewport changes are
`9a6e97ff6` and `0e4b316f5`. Each fresh
sample used a new adapter after the WASM was available. The table uses the last
four of five samples per session. An additional untimed replay counted exact
kernel classifications. Counts went from 40 to 1 on the smaller gear and
960 to 507 on the larger one. The cylinder took one call in both builds. The
blind-pocket regression keeps its two-call refusal when the first end is
blocked.

Each modifier session also ran a fresh replay, two warm-ups and five distinct
size edits. The digest of the entire published result, excluding its timestamp
and including raw mesh bytes, matched across all four runs for all 50 recorded
cases per run. The box timings varied on this host. Loading the project file,
worker transport and first presented frame fall outside these adapter timings.

The broader history matrix covered extrude, boolean, fillet, chamfer, pattern,
parameter and direct edits on both 33- and 100-feature documents. It compared
every edited warm result to an independent fresh rebuild with checkpointing
disabled, for 210 comparisons per build. This oracle checks published fields
and triangle counts. The separate gear digest above checks the mesh bytes.

| 100-feature operation edit | Baseline (ms) | Candidate (ms) |
| --- | ---: | ---: |
| Extrude | 25.4 | 23.9 |
| Boolean | 28.9 | 31.1 |
| Fillet | 25.5 | 27.2 |
| Chamfer | 38.2 | 28.1 |
| Pattern | 27.4 | 29.7 |
| Parameter | 24.4 | 25.9 |
| Direct edit | 25.5 | 25.4 |

These controls have five samples per cell from one session per build.
Differences ran in both directions on the shared host.

## Viewer interaction

Camera motion builds conservative bounds for groups of 32 contour candidates.
A group whose neighboring faces all face the same side of the camera can skip
the per-edge dot products. The draw buffer keeps its original segment order.
Deformed drag previews continue to test the moved segments. Poorly ordered
meshes release the bounds if they avoid less than a quarter of the scan.
Sparse highlights look up the affected edges directly and pack them in their
original topology order.

| Main-thread CPU workload | Baseline median range (ms) | Candidate median range (ms) |
| --- | ---: | ---: |
| Torus, perspective orbit update | 0.416–0.420 | 0.129 |
| Imported sleeve, perspective orbit update | 0.283–0.290 | 0.088 |
| Torus with 31/32 of its candidates shuffled, perspective orbit update | 0.441–0.458 | 0.433–0.437 |
| Highlight one of 20,000 edges | 0.828–0.843 | 0.003 |
| Highlight four of 20,000 edges | 0.896–0.900 | 0.006–0.007 |
| Highlight one of 12 edges | 0.005 | 0.004–0.005 |

The CPU probe recorded 240 steady-state updates per scene and projection per
run. All eight combinations produced matching contour-buffer digests over 120
frames. The first moving view pays for the index. On the torus this took
1.49–1.50 ms versus 0.41 ms, and on the shuffled torus 2.12–2.14 ms versus
0.41–0.42 ms. The index costs 48 bytes per 32 candidates, at most 220 KiB per
eligible body. An unchanged camera reuses its last outline.

### Browser frames

At normal CPU speed the p95 interval between the viewer's own consecutive
frames was 16.7–16.8 ms across the rounded block, 60-tooth gear, torus, sphere
row and imported sleeve on both builds.

With 10× Chromium main-thread CPU throttling, the same build could miss a
different number of refresh intervals between runs. The table gives the p95
from each of two six-second orbits per build. Other development processes
shared this host, and the viewer retained its adaptive pixel ratio.

| Scene | Baseline p95 frame interval (ms) | Candidate p95 frame interval (ms) | Baseline → candidate p95 viewer CPU (ms) |
| --- | ---: | ---: | ---: |
| Rounded block | 33.4 / 50.0 | 50.0 / 50.0 | 15.1–25.2 → 25.2 |
| Torus | 50.0 / 83.3 | 50.0 / 50.0 | 31.0–42.6 → 26.4–27.2 |
| Five spheres | 33.4 / 50.0 | 50.0 / 66.7 | 22.6–36.1 → 15.7–34.0 |
| Imported sleeve | 49.9 / 50.1 | 33.4 / 49.9 | 24.5–25.6 → 19.3–19.8 |

The torus and sleeve used less viewer CPU in both pairs. The five-sphere
scene had longer p95 frame intervals in both candidate runs. The browser
results support a reduction in contour work and leave the frame-pacing
problem open for that scene and for the device reporting low FPS.

## Reproduction

Run the same probes on both trees with the same lockfile. Use fresh output
paths for each run. Browser runs used Chromium 156.0.8078.4 with Vulkan on a
Radeon RX 6600, a 1366 × 1024 touch viewport at DPR 2, a warm-up gesture
and a six-second orbit. Browser operations ran one at a time. The CAD and
viewport probes each used a single Vitest worker. The initial isolated
fillet probe peaked at 668 MiB RSS and the initial viewport CPU probe at
506 MiB. These are process measurements of individual probes.

```sh
EDGE_REBUILD_OUT=/tmp/edge-run.jsonl pnpm exec vitest run --maxWorkers=1 test/perf/edge-modifier-rebuild.test.ts
OZ_VIEWER_CPU_PERF_OUT=/tmp/view-run.jsonl pnpm exec vitest run --maxWorkers=1 packages/viewport/src/render/interaction-perf.test.ts
CAD_PERF_RUN=1 CAD_PERF_HISTORY=33,100 CAD_PERF_SAMPLES=5 CAD_PERF_OUT=/tmp/history-run pnpm exec vitest run --config test/perf/cad-operations.config.ts
OZ_PERF=1 OZ_PERF_ANGLE=vulkan OZ_PERF_THROTTLE=1,10 OZ_PERF_WARMUP=1 OZ_PERF_SECONDS=6 \
  OZ_PERF_SCENES=rounded-block,torus,sphere-row,rotational-sleeve OZ_PERF_DIR=/tmp/orbit-run \
  pnpm exec playwright test test/e2e/perf-frame-timing.spec.ts --workers=1
```
