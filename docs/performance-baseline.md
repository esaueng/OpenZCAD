# Startup performance baseline

Findings from investigating the QA report's P-01, P-02, and P-03. The headline
conclusion is that **the slow startup phases are not application JavaScript**,
so the obvious optimisations would have moved nothing. One separate finding did
come out of it and has been fixed: a render-blocking web font, at the end.

Reproduce with:

```bash
OZ_PERF=1 pnpm exec playwright test perf-probe
OZ_PERF=1 pnpm exec playwright test perf-profile
```

Both are excluded from the normal suite: the numbers vary far too much between
machines and GPU states to gate CI on.

## Instrumentation

`apps/web/src/lib/perf.ts` emits standard User Timing entries under an `oz:`
prefix, so the same phases are visible in the DevTools performance panel, in
`performance.getEntriesByType('measure')`, and in the probe above. Phases
currently marked: `worker.create`, `document.hydrate`, `viewer.init`,
`viewer.renderer`, `viewer.environment`, `viewer.firstFrame`, `viewer.bodies`.

### Readiness marks

**LCP is not a readiness metric for the workspace.** The model is drawn
into a WebGL `<canvas>`, and canvas paints are not Largest Contentful Paint
candidates, so LCP picks whichever text is largest. LCP also keeps updating
until the first input. On a reload with no input, that is the one-line
workspace hint that replaces the startup status toast when the toast
expires. The 2026-10-29 production QA measured LCP at 8.8–9.5 s on a Heat
Sink reload whose model was on screen in about 2.3 s. Do not set budgets or
alerts on LCP for workspace pages, and do not reshape the hint to move the
number.

Two User Timing marks are the readiness signals instead
(`apps/web/src/lib/startupReadiness.ts`, emitted from the viewer's render
loop):

| Mark               | Meaning                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `oz:model-visible` | First rendered frame showing the opened project's exact geometry for its current version (analysis may be pending). |
| `oz:input-ready`   | First rendered frame after topology analysis is complete, when picking, selection and every modeling tool work.     |

Each mark fires once per opened project. A page load records the startup
project's pair first, and its `startTime` is milliseconds since navigation.
Stored meshes drawn while the kernel rebuilds do not count. Neither does a
project without bodies, which has no model to show. Read them in the field
with `performance.getEntriesByName('oz:input-ready')[0]` or a `mark`
`PerformanceObserver`. The lazy-chunk prefetch waits for `oz:model-visible`,
or for 15 s when no model is coming, before it starts fetching.

`scripts/measure-startup.mjs` reports both marks, the app's own startup
phases, long tasks, LCP and the network, over N runs of a production build
(`pnpm build` first):

```bash
# Returning user: open the demo once, then reload it N times (warm cache).
node scripts/measure-startup.mjs --runs 5 --headed
# First visit: a fresh profile per run, cache enabled, network-throttled.
node scripts/measure-startup.mjs --mode cold --runs 5 --network fast4g --headed
# Also record a Chrome trace per run (no sampling profiler) and attribute
# every main-thread task of 50 ms or more to the trace events inside it.
node scripts/measure-startup.mjs --runs 5 --headed --trace /tmp/oz-traces
```

`--cpu 4` adds CPU throttling and `--channel chrome` uses installed Chrome.
Headless Chromium renders WebGL with SwiftShader, so run `--headed` for GPU
numbers. The report names the WebGL renderer it measured.

### The startup long tasks (2026-10-29)

The QA trace's unattributed 618 ms task (F021) was captured with the CPU
profiler and screenshots on. The probe above, without the profiler, on a
Windows laptop (Intel UHD Graphics, ANGLE D3D11, headed Chromium, warm Heat
Sink reload, 5 runs per build) finds two long tasks per reload, both in the
viewer's start-up and neither WASM:

| Task                                   |   Duration | What is inside                                                                                                                                          |
| -------------------------------------- | ---------: | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| React commit that mounts the workspace | 136–223 ms | `viewer.init` 113–169 ms: the PMREM studio environment (`viewer.environment`, 69–106 ms) and renderer creation (21–34 ms); 64–97 ms is GPU round-trips. |
| The viewer's first animation frame     | 130–208 ms | `viewer.firstFrame` 123–169 ms, the first `renderer.render` of the empty stage; 115–163 ms is waiting on the GPU process for shader program links.      |

The kernel's WASM compiles and instantiates in the geometry worker
(`worker.firstReady` 537–1,071 ms), off the main thread. On this machine both
tasks finish before the worker delivers the model, so neither delays
`oz:model-visible` (median 911 ms, range 687–1,129 ms) or `oz:input-ready`
(median 980 ms, range 687–1,218 ms): the worker does. The model's own frame
is cheap (`viewer.bodies` about 10 ms).

A first visit grows these tasks, because a fresh profile has no GPU shader
cache. One traced cold run (fresh profile, Fast 4G) had a **1,488 ms**
mount task, almost all in `viewer.environment` (1,386 ms). Of that task,
1,299 ms was `GetProgramiv`, the main thread waiting on the GPU process to
link the PMREM shaders. The first frame took another 383 ms. Without
tracing, the five cold runs per build had longest tasks of 957–1,633 ms. No
task near 618 ms appeared in the warm runs. The QA task is most plausibly
this PMREM link wait on a partly cold shader cache, inflated by the
profiler, but that is not proven.

Two changes could cut the blocking. Neither moves readiness on this machine,
where the kernel arrives later, and neither is low-risk, so neither is made:

- Building the studio environment without a synchronous link: three.js
  `PMREMGenerator` has no async path, so this means a pre-baked environment
  or compiling its programs through `KHR_parallel_shader_compile`.
- Compiling the stage's programs with `renderer.compileAsync` before the
  first frame.

Measure on slower GPUs, and on a cold shader cache, before taking either.

### Lazy-chunk prefetch (F023)

The production HAR's 47 duplicate requests were the prefetcher fetching
chunks the page had already imported. They came from the network only
because DevTools' "Disable cache" was on. The prefetcher now skips any chunk
the page has requested, and starts only after `oz:model-visible`.
`measure-startup.mjs` counts requests from the page target only, so the
worker's kernel WASM is not in these totals. Same laptop, headed, 5 runs per
build:

| Heat Sink                                  |               Before |                After |
| ------------------------------------------ | -------------------: | -------------------: |
| Warm reload: requests / duplicates         |             215 / 45 |        171–172 / 0–1 |
| Warm reload: prefetch requests             | 156 (all cache hits) | 111–112 (cache hits) |
| Cold, Fast 4G: requests / duplicates       |             215 / 45 |              172 / 1 |
| Cold, Fast 4G: prefetch bytes              |              ~700 kB |               595 kB |
| Cold, Fast 4G: `worker.ready` (median)     | 12.6 s (11.1–19.3 s) |   9.4 s (8.6–11.5 s) |
| Cold, Fast 4G: viewer first frame (median) | 15.2 s (13.6–21.8 s) | 12.0 s (10.4–14.1 s) |

Every duplicate before was served from cache, so bytes moved little. The
cold-start gain is from waiting for the model. The old prefetch started at
startup-ready, while the library was showing, and competed with the kernel
download on a constrained link. The baseline build's bundle-evaluation time
also varied more (1.4–5.8 s against 1.3–1.5 s), so treat the cold gap as
indicative, not exact.

### Kernel timing harness for an offset-face edit

`test/perf/offset-face-perf.test.ts` times one offset-face direct edit on an
imported STEP body through the real exact adapter, in Node. For the cold
import sync and the edited sync it prints wall, kernel and remaining JS time,
every `RemusKernel` method by total time and call count, and the adapter's own
stage timings. It is skipped unless `OFFSET_PERF_STEP` names a STEP file, so
the normal `vitest run` never executes it. `OFFSET_PERF_DISTANCE` (default −6)
and `OFFSET_PERF_AREA` (default: the largest +X planar face) choose the edit.
`OFFSET_PERF_TRACE=1` also attributes the expensive kernel methods to their
calling frames; it is off by default because it is noisy and inflates the
methods it traces. `OFFSET_PERF_FULL=1` also times a second edit and the undo.
`OFFSET_PERF_PREVIEW=1` with `OFFSET_PERF_PREVIEW_TICKS=N` runs N
source-relative drag ticks. Above three ticks it prints a drag summary:
accepted and refused tick quantiles, per-method medians, and the growth of the
adapter kernel's arena slots and linear memory. `OFFSET_PERF_CALLS_OUT` writes
each report's ordered kernel calls as JSONL. `OFFSET_PERF_BACKGROUND_BODIES`
adds unrelated box bodies ahead of the import, so work that grows with the
document shows up. The
[2026-10-19 drag baseline](qa/face-drag-kernel-calls-2026-10-19.md) uses all
three.
`REMUS_WASM_PKG` and `REMUS_WASM_IO_PKG` run it against a local Remus build
through the `vitest.config.ts` overlay, without touching the pin or lockfile:

```bash
OFFSET_PERF_STEP=/path/to/part.step \
  pnpm vitest run test/perf/offset-face-perf.test.ts --reporter=verbose
# Against a local kernel, after `cargo xtask wasm-build` in a Remus checkout:
REMUS_WASM_PKG=<remus>/crates/wasm/pkg \
REMUS_WASM_IO_PKG=<remus>/crates/wasm-io/pkg \
OFFSET_PERF_STEP=/path/to/part.step \
  pnpm vitest run test/perf/offset-face-perf.test.ts --reporter=verbose
```

With the public Remus fixture `crates/io/tests/data/shapr3d_hammer_holder.step`
(160 faces, 42 NURBS) against the pinned kernel on an Apple M5 Pro
(2026-10-04, `main`, three runs, one traced): cold import sync 12.6–12.9 s,
offset sync (−6 on the largest +X face) 15.1–15.6 s, of which
`moveFacesJournaled` 4.0 s, `recognizeFeatures` 3.0 s and
`solidEdgeRelations` 2.7 s. Keep fixtures out of this repository.

## Interaction baseline

Reproduce with:

```bash
OZ_PERF=1 pnpm exec playwright test interaction-probe
```

The probe opens the Heat Sink demo, the existing model with the busiest edge
set, then drives a Shift+left-button orbit and right-button pan for about five
seconds. `ModelViewer` emits one `oz:viewer.frame` mark per rendered frame only
in an `OZ_PERF=1` build; each mark carries the frame interval plus
`renderer.info.render` draw-call and triangle counts. The spec is excluded from
the normal Playwright suite.

Baseline captured 2026-07-28 on a MacBook Pro (Mac17,9, Apple M5 Pro, 15 CPU
cores, 48 GB RAM) running macOS 26.5.2 arm64, Node 22.22.2, and Playwright's
headless Chromium. The WebGL renderer was ANGLE Vulkan over SwiftShader, so
these numbers describe the repeatable headless acceptance environment rather
than real-GPU user experience.

Three serial runs, with the median used as the baseline:

| Metric             |              Runs | Baseline median |
| ------------------ | ----------------: | --------------: |
| Interaction window |     5.743–5.885 s |         5.792 s |
| Rendered frames    |           197–226 |             222 |
| Frame time p50     |      17.5–25.0 ms |         24.9 ms |
| Frame time p95     |      33.3–41.7 ms |         33.8 ms |
| Frame time max     |    350.0–554.1 ms |        416.7 ms |
| Mean draw calls    |     133.05–133.14 |          133.12 |
| Mean triangles     | 5,493.58–5,565.37 |        5,513.75 |

The max is sensitive to one-off browser and software-renderer stalls. Use p95
as the input-path acceptance signal and mean draw calls as the render-loop
signal.

### After the input-path and render-loop fixes (2026-07-29)

Same machine and protocol, four serial runs, after merging the pointer-move
hover guard with rAF coalescing (PR #52) and the frozen shadow map plus
`powerPreference` (PR #55):

| Metric          |         Runs |  Median | vs. baseline |
| --------------- | -----------: | ------: | -----------: |
| Frame time p50  | 15.8–16.5 ms | 16.4 ms |         −34% |
| Frame time p95  | 18.0–33.4 ms | 25.8 ms |         −24% |
| Mean draw calls |       ~132.2 |   132.2 |   ≈unchanged |
| Mean triangles  |       ~2,998 |   2,998 |         −46% |

The split is diagnostic. Triangles nearly halved because the frozen shadow map
no longer redraws the body geometry every frame; draw calls barely moved
because they are dominated by the one-`Line2`-per-edge overlay, which neither
PR touched — that is the planned edge-consolidation work, and mean draw calls
remains the signal to watch for it.

### Wave 0 refresh on Windows ARM (2026-07-31)

This is a second-platform baseline, not a before/after comparison with the M5
SwiftShader numbers above. It used Windows NT 10.0.26200.0 on a 12-logical-core
Qualcomm ARMv8 system, Chrome 150.0.7871.187, and ANGLE Direct3D 11 on the
Qualcomm Adreno X1-85 GPU. The same Heat Sink probe and `OZ_PERF=1` production
build were used. Three successful serial runs were recorded; one intervening
repeat failed to reach the canvas and was replaced rather than treated as a
performance sample.

| Metric             |              Runs | Baseline median |
| ------------------ | ----------------: | --------------: |
| Interaction window |     5.646–5.923 s |         5.842 s |
| Rendered frames    |           330–339 |             334 |
| Frame time p50     |           16.7 ms |         16.7 ms |
| Frame time p95     |      16.8–17.1 ms |         16.9 ms |
| Frame time max     |      66.7–99.9 ms |         82.8 ms |
| Mean draw calls    |     130.75–130.94 |          130.76 |
| Mean triangles     | 2,984.11–2,984.38 |        2,984.16 |

Until edge-overlay batching lands, 130.76 mean draw calls is the Windows ARM
signal to reduce. A future result must use the same demo, probe, browser/GPU
path, and production instrumentation before it is called an improvement.

### Wave 1 edge-overlay batching (2026-07-31)

The same Windows ARM machine, system Chrome, Heat Sink demo, production
instrumentation, and interaction path were repeated after idle topology edges
were consolidated into one batch per visible body. Two valid serial samples
completed before three later cold demo builds stalled before the canvas was
created; those readiness failures contain no render samples and are reported
separately rather than mixed into the measurement.

| Metric             |             Runs | Representative midpoint | vs. Wave 0 |
| ------------------ | ---------------: | ----------------------: | ---------: |
| Interaction window |    5.520–5.908 s |                 5.714 s |          — |
| Rendered frames    |          326–351 |                     339 |          — |
| Frame time p50     |          16.7 ms |                 16.7 ms |         0% |
| Frame time p95     |     16.8–16.9 ms |                16.85 ms |        <1% |
| Frame time max     |     33.3–83.3 ms |                 58.3 ms |      lower |
| Mean draw calls    |      11.75–11.79 |                   11.77 |       −91% |
| Mean triangles     | 2,977.5–2,977.57 |                2,977.54 |        <1% |

The draw-call target is met without a p95 regression. The separate cold-build
readiness stall remains a test-infrastructure/product-startup risk to diagnose;
it occurred before `ModelViewer` mounted and therefore cannot validate or
invalidate the rendering result.

### Wave 2 topology-lineage overhead (2026-07-31)

A warm, process-local exact-box rebuild probe compared 100 BrepKit syncs with
schema-v5 lineage enabled against the same implementation with lineage
temporarily disabled. The temporary benchmark switch and probe were removed
after measurement.

| Exact box rebuild | Lineage enabled | Lineage disabled | Absolute overhead |
| ----------------- | --------------: | ---------------: | ----------------: |
| Median            |        2.145 ms |         1.428 ms |          0.716 ms |
| Mean              |        2.920 ms |         1.831 ms |          1.089 ms |

The percentage delta is intentionally not used as the gate because the fixture
is only a one-to-three millisecond operation. The absolute mean overhead stayed
below 1.1 ms; cross-kernel parity and real-document probes remain the meaningful
regression checks for later operation waves.

Every instrumented main-thread phase is small and stable:

| Phase                                         |  Typical |
| --------------------------------------------- | -------: |
| `worker.create`                               |    <1 ms |
| `document.hydrate`                            |    <1 ms |
| `viewer.init` (whole scene setup)             | 38–52 ms |
| `viewer.environment` (PMREM studio map)       | 26–31 ms |
| `viewer.firstFrame` (first `renderer.render`) | 17–20 ms |
| `viewer.bodies` (geometry → three.js objects) |     3 ms |

Against that, a single **~800–900 ms main-thread block** appears once per
session. A CPU profile attributes it almost entirely to V8's `(program)`
bucket — time spent _outside_ JavaScript, i.e. GPU/driver work, rasterisation
and shader compilation:

```
(program)  909 ms
(idle)     321 ms
three.js    29 ms   <- all application JS combined
```

### Wave 3 confirmation, and what the drag probe does _not_ measure (2026-08-07)

Re-run on the M5 SwiftShader environment described above, after the whole
edge-consolidation and selection-rebuild programme had landed:

| Metric          | 2026-07-28 baseline | 2026-08-07 | Change |
| --------------- | ------------------: | ---------: | -----: |
| Frame time p50  |             24.9 ms |    16.6 ms |   −33% |
| Frame time p95  |             33.8 ms |    17.6 ms |   −48% |
| Mean draw calls |              133.12 |      11.59 |   −91% |
| Mean triangles  |            5,513.75 |   2,801.19 |   −49% |

Mean draw calls was the agreed acceptance signal for edge consolidation, and
at 11.59 it has met it. The idle topology edges now render as the merged
`LineSegments2` batches in `packages/viewport/src/render/edgeOverlay.ts`, and
the selection-click rebuild is guarded behind `bodiesChanged`, so a
selection-only change reuses the existing objects instead of rebuilding them.

#### `frameIntervalMs` in the cylinder-radius probe is input-paced

The second probe reports something that reads alarming and is not a defect:

```
frameIntervalMs: { p50: 44.2, p95: 182.6, max: 195 }
```

That is not render throughput. The probe deliberately sleeps between synthetic
pointer moves, so the interval between rendered proxy frames is bounded below
by how fast the harness delivers input. Removing only that sleep, changing
nothing in the application:

| Metric                | With 10 ms sleep | With 0 ms sleep |
| --------------------- | ---------------: | --------------: |
| Frame interval p50    |          44.2 ms |         33.2 ms |
| Frame interval p95    |         182.6 ms |         58.3 ms |
| Input-to-frame p50    |           0.6 ms |          0.8 ms |
| Rendered proxy frames |               40 |              40 |

The residual 33.2 ms is two frames at this environment's 16.6 ms, with 40
frames produced from 80 moves — one render per animation frame, which is
exactly what the rAF coalescing is supposed to do.

**Use `inputToFrameMs` as this probe's signal, not `frameIntervalMs`.** At
0.6–0.8 ms p50 it says the drag is responsive; the interval figure mostly
describes Playwright's pacing. Recorded here because the p95 of 182 ms is
misleading enough to have already sent one investigation looking for a stall
that does not exist.

### Wave 4 gesture coverage and the phantom edge batches (2026-08-12)

Two things landed here: a rendering regression fix, and three probe scenarios
that measure the gestures the original probe never touched.

**The regression.** `BodyEdgeOverlay` allocates its hover, selection, and
face-boundary batches at full idle capacity so later updates never
reallocate, but the geometry reported that capacity as live instances.
`refreshVisibility` reads `instanceCount` for the hover tiers, so installing
a body — which applies the display mode — drew every body's entire edge set
twice as zero-length segments until the first edge hover, and every scene
rebuild brought them back. Bisected to the visual-selection phases: PR #293
added ~1,968 triangles and PR #295 ~1,969 more.

| Metric          | `d8561c7` (pre-vsel) | `ef77d45` (regressed) |   Fixed |
| --------------- | -------------------: | --------------------: | ------: |
| Frame time p50  |              16.7 ms |               24.9 ms | 16.7 ms |
| Mean draw calls |                11.58 |                  13.9 |   12.32 |
| Mean triangles  |                2,801 |                 6,530 |   2,595 |

**New scenarios.** `hover sweep`, `move drag`, and `preview drag` join the
orbit/pan probe and the cylinder proxy. Each reports `reactCommits`
alongside frame times: `App` increments a counter in a dependency-free
effect under `OZ_PERF`, so a probe can see whether a gesture is driving the
component tree. The viewport owns per-frame values imperatively, so a
refined gesture should commit on its lifecycle edges and nowhere in between.

Baseline on the M5 SwiftShader environment, 2026-08-12, after the fix above:

| Scenario                | Frame p50 | Frame p95 | React commits | Note                        |
| ----------------------- | --------: | --------: | ------------: | --------------------------- |
| Orbit + pan             |   16.7 ms |   25.0 ms |             — | camera only                 |
| Hover sweep (121 moves) |   16.7 ms |   25.0 ms |         **0** | fully imperative            |
| Move drag (60 moves)    |   25.0 ms |   33.4 ms |        **61** | one commit per pointer move |
| Preview drag (50 moves) |   25.0 ms |  508.4 ms |            10 | scene teardown per publish  |

The last two rows are the measurement this wave existed to get. Hover is the
reference for what the interaction stack does when it behaves: 121 pointer
moves, zero React commits. A move drag commits once per pointer move because
`setMoveSnap`/`setMovePreview` run per event in a tree with no memoized
components. The preview drag's 508 ms p95 is a rebuild of the whole scene on
each published preview — the body list changes identity, so meshes, edge
batches, hover state, and the shadow map are all torn down mid-gesture.

**Read `frames` before reading `frameTimeMs` in these scenarios.** The mark
records the interval since the previous rendered frame, and the viewport
renders on demand. Removing a redundant invalidation therefore _raises_
`frameTimeMs` while lowering the work done, because the loop simply idles
longer between frames. Memoizing the viewport's array props (below) took the
move drag from 121 rendered frames to 61 for the same 60 pointer moves — one
render per move instead of two — and the p50 interval rose from 25 ms to
43 ms saying so. Use `frames` for invalidation volume, `reactCommits` for
component-tree traffic, and p95/max for genuine stalls.

#### What the preview drag's 500 ms frames are not (2026-08-13)

The preview-drag scenario's p95 was read as the scene teardown that happens on
every published preview. Instrumenting each step of that path on the Heat Sink
offset drag rules that out, and rules out everything else on the main thread:

| Path                                          |                      Cost across the whole drag |
| --------------------------------------------- | ----------------------------------------------: |
| Scene rebuild (`oz:viewer.bodies`)            |         8 ms total, 2.9 ms max, over 4 rebuilds |
| `LivePreview.build()`                         |                            8 ms total, 1 ms max |
| `postMessage` serialization                   |                                      3 ms total |
| `publish()`                                   |                                            0 ms |
| Dimension labels, CSS2D render, callout clamp |                     35 ms total over 131 frames |
| `renderer.render`                             |               319 ms over 131 frames, 38 ms max |
| Worker round trip                             | 74–211 ms, of which 60–138 ms is kernel compute |

The same drag contains six long tasks of 500–693 ms. A move drag, which runs
no kernel preview, contains one of 71 ms — so the stalls do belong to the
preview round trip, but to no instrumented step of it, and `renderer.info`
shows shader programs steady at 16, so it is not program churn.

Main-thread time attributable to no JavaScript is the signature already
recorded above for startup, where a CPU profile put ~909 ms in V8's
`(program)` bucket and where the same work cost ~900 ms headless against
~40 ms headed on a real GPU. **Re-measure this one headed on target hardware
before optimising it**, exactly as the startup finding says.

#### The same probes on the target GPU (2026-08-13)

Answering the question the section above ends on. Identical build and probes,
run headed on the same machine so the renderer is ANGLE Metal on the Apple M5
Pro rather than SwiftShader:

| Scenario                | Frame p50 | Frame p95 | Frame max | React commits |
| ----------------------- | --------: | --------: | --------: | ------------: |
| Orbit + pan             |    8.3 ms |    8.9 ms |   16.8 ms |             — |
| Hover sweep (121 moves) |    8.4 ms |   16.7 ms |   17.6 ms |             0 |
| Move drag (60 moves)    |   16.7 ms |   17.6 ms |   91.7 ms |             2 |
| Preview drag (50 moves) |    8.4 ms |   25.1 ms |   33.5 ms |             6 |

Cylinder-radius input-to-frame stays at 0.9 ms p50, and the coalescing probe
still collapses 120 synthetic moves into 2 applications.

**The preview drag's half-second frames do not exist here**: p95 is 25 ms
against ~500 ms under SwiftShader, and the worst frame in the whole drag is
33 ms. That closes the question this document raised — the stall was a
software-rasteriser artifact, exactly as the startup finding warned it might
be, and no scene-rebuild work is justified by it.

**The move drag row is input-paced, not half rate.** It reads 16.7 ms p50
against orbit's 8.3 ms, which looks like a drag costing twice a frame. It is
not: that scenario sleeps 10 ms between synthetic moves, and with the sleep
removed and nothing else changed the same drag reports **8.3 ms p50 / 8.9 ms
p95** — identical to orbit. It renders 62 frames for 60 pointer moves, one per
move, so the harness sets the interval. This is the same trap the
`frameIntervalMs` note below describes, and it survived one round of
investigation here (a per-frame shadow-map refresh was suspected and measured
out: disabling it moved p50 not at all).

So the honest reading of the table is that **every measured gesture meets the
frame budget on target hardware**, and no frame-pacing work is justified by
these numbers. What remains of the felt jank is not throughput: it is the
feedback and motion behaviour catalogued in the audit — highlights that pop
instead of easing, selection that never fades out, gizmos that appear with no
transition or hover affordance, no trackpad pan — plus whatever gesture-start
latency costs, which these scenarios do not measure.

Treat this table as the acceptance baseline for interaction feel. The
SwiftShader numbers remain useful for draw calls, triangles, React commits,
and drag applications, which are hardware-independent; they are not evidence
about smoothness.

**A third harness note, for drag coalescing.** Neither the scenarios above nor
any CDP-driven drag can show whether drag work is coalesced: each
`page.mouse.move` round-trips and yields, so the browser paints between
events and the drag runs once per move whatever the code does. The
`drag coalescing probe` dispatches its burst of `pointermove` events
synchronously from page script instead, carrying the real gesture's pointer
id, so the whole burst lands before a frame can run. It reports 120 pointer
events collapsing to 1 application of the drag path, and 120 applications
when the coalescing is removed.

Two harness notes, both of which produced a probe that measured nothing:

- The offset handle's value chip is a DOM overlay anchored on top of the
  handle, so a synthetic press at the published handle point hit-tests to the
  chip and never reaches the canvas. The probe now walks along the drag axis
  for the nearest point that hit-tests to the canvas, which is where a person
  aims anyway.
- Scaling a drag by the handle's published pixels-per-unit walks the pointer
  off the canvas and silently ends the drag. Drag distances are bounded in
  pixels instead.

### P-02 — "cold project creation exceeds 1 s"

Real, but it is not project creation. Across five runs, cold creation was
~75 ms four times and 1028 ms once, and the first geometry operation moved
inversely (~1700 ms vs 453 ms). It is one shared one-time WebGL warm-up that
attaches to whichever interaction happens to trigger the first real draw.

The report's P-01 and P-02 are therefore two views of the same cost, not two
defects.

### Environment sensitivity

The same warm-up cost measured ~900 ms headless (SwiftShader software
rendering) and ~40 ms headed on a real GPU with a warm shader cache — but
537 ms on the _first_ headed run, before that cache existed. The QA report's
figures came from headless runs, so they overstate what a user on a GPU sees.
**Re-baseline on target hardware before optimising this.**

### P-01 — existing-document reload

Not reproduced. The probe's reload returns to the start screen rather than
restoring the workspace, so the report's 3,551 ms exact-document reload path
was never exercised here. It needs a durable project against the real API.

### P-03 — bundle size

The kernels remain off the UI thread and are now lazy at both boundaries: an
empty project does not import the exact adapter/Remus. (OCCT was a second
lazy boundary for STEP work when this was measured; Z3 removed it — see the
note under the table.) A fresh Vite 8.1.5
production build on 2026-07-31 emitted the following current entry and worker
chunks (decimal kB, using Vite's gzip report):

| Asset                             |          Raw |        Gzip |
| --------------------------------- | -----------: | ----------: |
| Main application JS               |    646.73 kB |   196.53 kB |
| Three.js chunk                    |    601.59 kB |   151.39 kB |
| Application CSS                   |     88.25 kB |    14.96 kB |
| Geometry worker JS                |    103.44 kB |    24.73 kB |
| Topology fingerprint worker chunk |     42.14 kB |    14.98 kB |
| BrepKit WASM (lazy worker asset)  |  5,221.62 kB | 1,881.73 kB |
| OCCT WASM (lazy STEP asset)       | 22,088.41 kB | 7,099.78 kB |

> **Superseded for OCCT (Z3, 2026-08-01).** The STEP route flip removed the
> last reachable importer of `occt-step.ts`, and because that import was
> already dynamic the 22,088.41 kB asset simply stopped being emitted. The row
> is kept so the size that was removed stays on the record. Every other line
> predates the flip and is unaffected by it; re-measure with
> `pnpm build:report`.

> **Z5 (2026-08-01), measured rather than assumed.** The claim above — that
> the WASM payoff was fully banked at Z3 — holds for the WASM and only for the
> WASM. A build immediately before Z5 emitted no OCCT asset and totalled
> 10,174,485 bytes across reported assets (`apps/web/dist` 12,292,594 bytes on
> disk), but `grep -i occt apps/web/dist` still **hit**: `assets/index-*.js`
> carried the `OCCT_SHARP_OFFSET_LIMITATION` string and the
> `capability.kernel === 'occt'` branch that could never be true after Z3.
> Deleting them is the last of it:
>
> | Measure                             |    Before Z5 |     After Z5 |  Delta |
> | ----------------------------------- | -----------: | -----------: | -----: |
> | `assets/index-*.js` raw             |    400,750 B |    400,429 B | −321 B |
> | `assets/index-*.js` gzip            |    114,840 B |    114,690 B | −150 B |
> | All reported assets, raw            | 10,174,485 B | 10,174,164 B | −321 B |
> | `apps/web/dist` on disk             | 12,292,594 B | 12,292,273 B | −321 B |
> | Files matching `occt`/`opencascade` |            1 |        **0** |      — |
>
> So the honest accounting is: Z3 banked 22,088 kB; Z5 banks 321 bytes and the
> property that the shipped bundle contains no OpenCascade at all. What Z5
> actually recovers is source, not payload — see the Z5 entry in
> `docs/kernel-execution-plan.md` for the line counts.

> **ADR-020 Remus migration (2026-08-15), measured on the migration branch.**
> The pinned `esaueng/remus@20ac744` package emits a 7,605.80 kB raw / 2,522.82
> kB gzip lazy WASM asset. The prior 6,815,744-byte kernel ceiling rejected the
> build; the explicit kernel-only ceiling is now 8 MiB, leaving 782,806 bytes
> of headroom. The asset remains absent from launcher HTML and loads only with
> non-empty geometry. All reported assets total 13,290,327 bytes raw / 4,241,003
> bytes gzip for this build.

> **Staged Remus size policy (2026-08-31).** The current OpenZCAD pin
> `e30110e0504b7f5f0753b24cf5d6c80e2592b117` emits an 8,771,141-byte raw /
> 2,893,806-byte Node-gzip / 2,008,808-byte Brotli-q11 kernel. The former 9 MiB
> hard limit is now the mandatory-review threshold; 10 MiB raw and 3.5 MiB
> gzip are independent hard limits, and 2.5 MiB Brotli remains advisory. The
> launcher's lazy-asset exclusion is still enforced. See
> `docs/kernel-wasm-size-policy.md` for measurement and ceiling-raise rules.

> **Optimized Remus consumer package (PR #165, 2026-09-01).** The official
> updater advanced the immutable pin from `e30110e0504b7f5f0753b24cf5d6c80e2592b117`
> to `19e6b3a989106a47f2d1d5ff826f44a1ebe39a65`. Its exact-artifact comparison
> measured 7,776,918 bytes raw / 2,747,755 bytes Node-gzip / 1,955,827 bytes
> Brotli-q11: reductions of 994,223 bytes (11.34%), 146,051 bytes, and 52,981
> bytes respectively. A production bundle reproduced all three after the pin;
> the result remains a lazy worker asset. These byte measurements close the
> package-size slice, not the separate cold-load, compilation, instantiation,
> or runtime-memory baselines.

## W3 exact Remus WASM browser baseline (2026-09-09)

This baseline measures the exact hashed kernel asset emitted by a production
OpenZCAD build, not a rebuilt or package-local substitute. The harness resolves
the single kernel WASM path through `build-meta.json`, refuses missing or
ambiguous provenance, verifies the WASM header, and records the asset SHA-256.
Reproduce it from a clean checkout with a Chromium installation available to
Playwright:

```bash
pnpm install --frozen-lockfile
OPENZCAD_BUILD_COMMIT="$(git rev-parse HEAD)" pnpm build
pnpm perf:remus-wasm -- --runs 20 --out remus-wasm-load-baseline.json
```

Each sample launches a fresh persistent Chromium profile. The cold phase
fetches and materializes the raw asset through an empty browser cache, compiles
it with `WebAssembly.compile`, and instantiates the compiled module. The warm
phase releases that instance, forces garbage collection, and repeats in the
same browser process; all 20 warm fetches were browser-cache hits with zero
transfer bytes and zero server requests. Median is the midpoint of the two
central samples and p95 uses nearest rank. The retained JSON report contains
every raw sample:
[`docs/qa/2026-09-09/remus-wasm-load-baseline.json`](qa/2026-09-09/remus-wasm-load-baseline.json).

Provenance: OpenZCAD `0c9ef463dcf77cbaf847c4e250ffa7eeafd5f1fc`,
Remus `e582373be77e2bcf91f07556a68a387c404356a5` (`remus-wasm`
2.130.1), emitted asset `assets/remus_wasm_bg-BgEHvaI6.wasm`, SHA-256
`f7c39447756746eea5f963dc974635aabef20a526c328881a6568d52d5fe0819`.
The asset is 8,146,512 bytes raw, 2,845,435 bytes Node-gzip, and 2,005,289
bytes Brotli-q11.

| Exact emitted kernel metric | Cold median |  Cold p95 | Warm median |  Warm p95 |
| --------------------------- | ----------: | --------: | ----------: | --------: |
| Load + byte materialization |    91.47 ms | 166.14 ms |    77.98 ms | 111.80 ms |
| Compile                     |    20.73 ms |  29.53 ms |    17.79 ms |  26.69 ms |
| Instantiate compiled module |     0.87 ms |   0.92 ms |     0.75 ms |   0.88 ms |
| Initial WASM linear memory  |    1.25 MiB |  1.25 MiB |    1.25 MiB |  1.25 MiB |
| Retained payload floor      |    9.02 MiB |  9.02 MiB |    9.02 MiB |  9.02 MiB |
| Post-GC JS-heap delta       |    0.27 MiB |  0.27 MiB |    0.18 MiB |  0.18 MiB |

The retained payload floor is the raw `ArrayBuffer` plus exported initial WASM
linear memory. It deliberately excludes compiled-code/native engine overhead,
so it is a lower bound rather than a total-process-memory claim. Chromium
151.0.7922.34 reported `measureUserAgentSpecificMemory` as unavailable even in
the cross-origin-isolated harness; the JSON retains that failure and the
separate CDP JS-heap delta instead of substituting an estimate.

### Environment and limits

The target was a desktop-class AMD Ryzen 9 5900XT (16 cores / 32 logical CPUs),
32 GB RAM, x86-64 Pop!_OS Linux kernel 7.1.5, Node 24.14.0, and Playwright
headless Chromium 151.0.7922.34. The CPU governor reported `powersave`. Other
concurrent work kept the one-minute load average between 24.01 and 29.20 during
the retained run, so these are loaded-host observations, not idle-machine
ceilings. Chromium profiles used `/dev/shm` because the host filesystem had
less than 1 GiB free.

The loopback server removes WAN, TLS, CDN, and content-encoding variance, so
`load` measures browser receipt and raw-byte materialization rather than user
download time. The harness uses signature-compatible no-op function imports to
isolate module instantiation; it does not call `__wbindgen_start`, construct a
`BrepKernel`, run inside the geometry worker, or measure the end-to-end
`loading-remus` UI phase. Headless Chromium is representative of the desktop
V8/WebAssembly engine but not mobile-class or constrained hardware. Those
boundaries keep this result to the W3 exact-asset slice; W4 cold rebuild, warm
cache hit, eviction, large-document clone, STEP first-load, and retained worker
heap remain open.

### Budget disposition

No new latency or retained-memory gate is justified by this one loaded desktop
baseline. The existing deterministic raw/gzip hard limits remain the only hard
WASM gates, and exact build provenance remains a harness precondition. A timing
or memory gate needs matched quiet-host repeats on at least one desktop and one
constrained/mobile-class target, using the real worker/glue startup path; until
then this report is a comparison baseline, not pass/fail policy.

**Update (2026-10-13).** The harness now also times kernel-ready through the
real glue startup path (`instantiateStreaming`, `__wbindgen_start`, the first
`BrepKernel`) in a desktop and a mobile-class profile, and
[`docs/kernel-wasm-size-policy.md`](kernel-wasm-size-policy.md#load-time-budget)
sets review budgets from that baseline. Those runs shared a loaded host, so the
budgets are review signals rather than hard gates. The module phase above now
instantiates asynchronously: Chromium refuses the synchronous
`new WebAssembly.Instance` on the main thread for modules over 8 MB, and the
pinned 2026.1.53 kernel is 10,406,201 bytes, so the unchanged harness failed
on it.

The three eager UI assets total about 362.9 kB gzip. PDF worker/runtime assets
are emitted separately and are loaded only when reference-document support is
used. Reproduce the complete raw/gzip inventory with `pnpm build:report`; the
script reports every JS, CSS, and WASM asset instead of depending on hashed
filenames in this document.

## H02 first parameter edit after reload (2026-09-17)

Measured for ROADMAP row H02 on an Apple M5 Pro with the production preview
build and, for comparison, the Vite dev server:
[`docs/qa/2026-09-17/first-edit-after-reload.md`](qa/2026-09-17/first-edit-after-reload.md).
Once a reload has settled, the first parameter edit costs what any warm edit
costs, because the exact history cache restores its prefix from the reload's
own rebuild. An edit typed before the reload settles pays that reload once.
The per-edit floor on a drilled holder is measurement of the edited body
(planar-distance edit proofs 0.6–0.7 s), not history replay. The probe is
`test/e2e/perf-holder-reload.spec.ts` under `OZ_PERF=1`; `OZ_PERF_BUDGET=1`
asserts the within-run ratios the report pins.

## Edited imported body measurement (2026-10-04)

One `syncDocument` for an offset-face direct edit (−6 mm on a +X planar face)
of the 160-face Remus hammer-holder test fixture (42 NURBS patches), in Node
against the pinned kernel on an Apple M5 Pro. Three interleaved runs per
build, medians; a local probe wraps every `RemusKernel` method with a timer.
Call counts are deterministic.

| Offset-face sync                   | Before (`main`) |        After |
| ---------------------------------- | --------------: | -----------: |
| Wall                               |         15.34 s |      11.91 s |
| Opening recognition stage          |          3.00 s |      not run |
| Imported feature recognition stage |          6.09 s |       5.70 s |
| `validateSolid` calls              |   12 (2 293 ms) |            0 |
| `faceArea` calls                   |  510 (1 006 ms) | 162 (330 ms) |
| `intersectDetailed` calls          |      3 (270 ms) |            0 |

The cold import of the same file goes from 12.62 s to 11.97 s (`faceArea`
508 → 188 calls). Body volume, face count and warnings are identical.

Two changes. The opening is measured only on an import under at most fixed
moves or rotations, which is the only body the growing-holder recipe compiles
against; any other imported body publishes an unsupported opening with that
reason. And one body measurement reads each face's geometry once, shared by
the published face geometry, the imported-feature query and the opening
inventory.

What remains is kernel work: the edit itself (`moveFacesJournaled`, 3.97 s)
and imported-feature recognition, which is two whole-solid queries
(`recognizeFeatures` 2.98 s, `solidEdgeRelations` 2.70 s). Recognition is not
carried through the edit. On this fixture the edit shrinks three recognized
fillet bands along the moved face from 8 mm to 2 mm and makes a radius-8 band
recognizable, so a carried result would publish stale proofs, and hole edits,
face-distance proofs and the edit catalog bind to it on edited bodies. Taking
it off the critical path needs faster kernel queries or a two-phase
publication (geometry first, recognition after); the worker protocol and the
assistant panel have no such phase today. Regressions:
`test/edited-import-opening.test.ts`,
`packages/kernel-adapter/src/exact-measure.test.ts`.

## Exact-kernel fixture refresh (2026-07-31)

`test/parity/parity.test.ts` passed all 24 cross-kernel cases. The committed
reference fixtures remain:

| Fixture          | Volume (document units³) | Faces |
| ---------------- | -----------------------: | ----: |
| Mounting Bracket |       47,359.86643659094 |    17 |
| Pipe Flange      |       78,314.20649420349 |    15 |
| Heat Sink        |      63,313.412896981696 |    42 |
| Drill row Body   |       34,673.60481847148 |    11 |

The Wave 0 topology-history characterization passed all three suites for the
pinned BrepKit and OCCT kernels; Z5 removed its OCCT suite along with the
kernel, leaving the two BrepKit suites. The separately verified primitive, sweep,
and supported rigid-transform lineage subset is now implemented; those broader
history probes still do not prove boolean, blend, pattern, direct-edit, or STEP
lineage. ADR-013 records the remaining bridge-gated gaps.

## Wave 5 exact-worker cache baseline (2026-07-31)

The geometry worker now lazy-loads the exact adapter and keeps a worker-local
canonical rebuild cache. This section records configuration and verification,
not a latency improvement claim: no matched target-hardware before/after run
has been captured yet.

Current safety bounds:

| Limit                            |  Value |
| -------------------------------- | -----: |
| Completed LRU entries            |      8 |
| Accounted keys + derived results | 32 MiB |
| Distinct in-flight loads         |      4 |

The key is stable canonical project JSON excluding `derived`; returned values
are structured-cloned, identical in-flight keys share one load, failed or
oversized results are not stored, and exports bypass the cache. Unit coverage
verifies key stability, clone isolation, in-flight deduplication, LRU/byte
eviction, termination, and newest-broadcast publication. These facts establish
safety behavior only.

Before changing the bounds or claiming a performance win, collect on the same
target machine and browser:

1. cold first non-empty rebuild, including `loading-remus`;
2. warm identical-document cache hit;
3. canonical edit miss versus derived-only hit;
4. eviction latency after 8+ representative documents;
5. retained worker heap with large embedded STEP sources; and
6. Remus first-load time for a STEP document (this used to read "OCCT";
   after Z3 it is the same load as line 1, since one kernel builds imports).

Report median and p95 separately, include document byte size/body/face counts,
and distinguish kernel load, exact rebuild, structured clone, and main-thread
attachment. ADR-015 fixes the correctness and memory contract while leaving the
limits tunable after this evidence exists.

## Fixed: render-blocking web font

`apps/web/index.html` used to load Google Fonts as a render-blocking stylesheet
in `<head>`. It consistently took **179–220 ms**, starting at ~11 ms against a
first contentful paint of 236–288 ms — so it sat on the critical path for every
cold visit, on real hardware as much as in CI. Unlike the GPU warm-up above,
this was unambiguously worth fixing.

The fonts are now self-hosted (PR #26, a separate branch from this one), which
removes the blocking request rather than relocating it: the `@font-face` rules
ride in the CSS bundle the page already loads. Latin subsets only, at the two
weights the tokens use.

Confirmed by a controlled A/B — the change stashed and re-measured on the same
machine and harness, three cold loads each. The absolute numbers run a little
higher than the figures above because this harness waits for the paint entry
rather than sampling it opportunistically; compare the rows, not the runs:

|        |                FCP | DOMContentLoaded | Third-party hosts |
| ------ | -----------------: | ---------------: | ----------------: |
| Before | 216 / 220 / 436 ms |       187–403 ms |                 2 |
| After  |    56 / 60 / 64 ms |         29–33 ms |                 0 |

`font-display: swap` behaviour is unchanged — text still paints immediately in
the fallback stack — but the swap now resolves in ~14 ms from same-origin
assets instead of over a third-party connection.

This is the only finding here that has been acted on. Everything above remains
measurement only.

## Terminal cap dragging (2026-09-21)

A supplied stepped, rounded part exposed a gap between primitive previews and
ordinary face offsets: after an additive extrusion, neither end qualified for
the immediate cylinder preview. Every drag update waited for exact geometry,
mesh/face measurements and viewport installation. The progressive scheduler
then waited for another rebuild-sized interval before starting the latest value.

`capPreviewProfile.ts` now recognizes a terminal circular disk, one full
cylindrical wall and an optional convex toroidal rim from the current exact
body's measurements and display topology. Every other face must lie behind the
straight span. This bounds deformation to that end: the cap and round translate,
the straight wall changes length, and shoulders and the other end stay fixed.
Missing/overlapping mesh ranges, holes or incomplete walls, off-axis rounds,
additional geometry crossing the span, and oversized inputs decline the preview.
Recognition is display-only; it does not change the exact command, history,
tolerances or exported geometry. The existing disposable profile controller
handles cancel, reversal, range refusal and retention through release validation.

For gestures that still need exact previews, `LivePreview` retains one active
request and the newest pending value, but now yields only 8–32 ms after a result
while respecting its configured minimum request interval. It no longer doubles
the worker rebuild plus presentation duration. The scheduler regression exercises
both a measured presentation cost and a 1.5-second rebuild with superseded input.

Local measurements on an Apple M5 Pro, headless Chrome, a 1512 × 950 viewport,
the same supplied model and the same 60-position top-cap drag:

| Measurement                              | Baseline (`91c34841`) | With cap preview                                      |
| ---------------------------------------- | --------------------- | ----------------------------------------------------- |
| Geometry worker requests during the drag | 10                    | 0                                                     |
| Exact preview worker round trip          | 146–162 ms            | None during drag                                      |
| Interval between exact-preview requests  | Median 405 ms         | Not applicable                                        |
| Input event to preview frame mark        | Not instrumented      | Median 14.5 ms; max 17.7 ms across 11 snapped changes |
| Exact rebuild on release                 | 141 ms                | 133 ms                                                |

The before/after rows distinguish update cadence from input-to-frame latency;
they are not interchangeable speedup ratios. The after build enables `OZ_PERF`
and uses the existing `oz:offset-face.proxy-frame` mark, emitted after the render
call, not GPU completion or monitor scanout. The 60 pointer positions produce 11
changes after grid snapping. Both sessions show the unrelated box as well as the
edited part. These are local samples, not universal latency guarantees. The
private recording/model and raw probe output remain outside the repository.

Verification uses an independently authored revolved stepped-cylinder fixture:
`cap-preview-profile.test.ts` checks both ends and a rotated part against exact
volume and bounding-box oracles, re-recognition after edits and conservative
refusals. `cylinder-preview.spec.ts` exercises real handle drags in both directions,
reversal, cancel, zero worker requests during drag, delayed exact release, fixed
opposite ends and undo. Existing compound-offset and unsupported-face preview
regressions continue to cover the fallback. Instant previews do not make exact
release validation instantaneous or extend the kernel's supported edit families.

## Split-rim imported cylinder preview (2026-09-28)

An imported cylindrical end could fail terminal-cap preview recognition while
its opposite end remained responsive. The affected wall had two semicircle
edges on each rim and a shared seam. Remus derived its periodic integration
bounds from the edge vertices alone; half-turn jumps unwrapped into a 3π range
instead of one 2π revolution. The wall area was therefore reported 50% too large,
and the complete-cylinder area guard in `capPreviewProfile.ts` correctly refused
that inconsistent measurement.

The kernel fix derives curved cylinder boundary bounds from sampled edge paths,
so the angular winding is determined by the actual arcs. Integration still uses
the analytic surface. OpenZCAD keeps its existing area, topology, holes, partial
wall and moving-span guards; exact edit validation remains authoritative on
release. The regression uses an independently authored split-rim STEP cylinder;
the supplied model and recording are not stored in this repository.

The observable performance change is eligibility for the existing bounded
visual preview on both ends. This removes repeated exact rebuilds from the
recognized drag path; it does not promise faster exact commit validation. Broader
history-cache, measurement-cache and optional-analysis changes are outside this
fix.

Coverage includes the split-rim wall at two sizes and axis orientations, both
cap recognitions, exact offsets and STEP export. The browser regression drives
both imported caps through reversal, cancel, delayed exact release and undo,
and asserts zero geometry-worker rebuild requests during the drag. The generic
fixture reproduced the 1.5× area error with the previous kernel and passes with
the paired fix from [Remus #807](https://github.com/esaueng/remus/pull/807).

## H02 matched-cache benchmark preparation (2026-10-15)

The [current evidence and reproduction](qa/2026-10-15/h02-matched-cache-benchmark.md)
retain the existing production holder-reload probe and add explicit
cache-disabled/enabled benchmark builds, paired input validation, per-stage
median/p95 reporting and optional post-GC Chromium geometry-worker JS heap
telemetry. Only test configuration changes cache budgets; runtime defaults
remain unchanged. Measurement reporting handles overlapping outer timers in
the staged-analysis pipeline.

The current-pin local holder oracle matches normalized publication across
17 bodies and 720 faces, and the unchanged-source payload hit matches its full
buffer bytes and structure. The browser campaign produced no complete matched
pair before being stopped under severe unrelated host contention (load average
150.53 on 32 logical CPUs). No timing, browser retained-heap or 20% p95 claim is
made. A quiet target-machine campaign and the design's separate branch-lifetime,
mutation, B-rep and retention qualifications remain required. H02 stays Partial.

## H02 existing-cache qualification (2026-10-21)

The [follow-up evidence](qa/2026-10-21/h02-existing-cache-qualification.md)
records three completed production-preview matched pairs on the shared Linux
host at runtime `6cd0838b` / paired Remus `0d942168`. All six within-run browser
budgets pass. Exact completion median is 8,571.1 ms disabled / 7,704.5 ms enabled;
nearest-rank p95 is 12,386.6 / 9,348.2 ms, an observed 24.5% improvement. Arm-start
load ranges from 18.67 to 38.37, so this does not replace a quiet M5 Pro campaign.
All six post-GC worker JS-isolate probes succeed; medians are 15,828,836 /
21,953,712 bytes. Whole-worker retention and a sustained private-session bound
are not established by those endpoint JS-heap observations.

The private oracle additionally compares every per-body serialized B-rep byte:
all 3,204,155 bytes match across 17 bodies, and normalized publication still
matches across 720 faces. Measurement-cache byte-pressure eviction and retired
checkpoint regressions pass. H02 remains Partial: the detached Text proposal
still needs branch-preserving kernel support and dependency/lifetime analysis;
no extra branch allocation or runtime cache behavior is enabled. The maintainer
will run target-machine acceptance from a local Codex chat using the handoff in
the evidence record.

## H02 M5 Pro private qualification (2026-10-21)

[The local qualification record](qa/2026-10-21/h02-m5-pro-qualification.md)
retains all three alternating matched pairs on the unchanged `6cd0838b` runtime
and paired Remus `0d942168`. Exact-completion p95 is 4,784 → 2,938 ms (38.6%
lower); arm-start load is 10.62–26.82, so quiet-host acceptance remains open.
The 80-edit private browser session completes real eviction, two kernel recycles,
refusal/recovery, durable worker restart and repeated post-GC observations.
Raw B-rep matches all captured fresh oracles, but five sustained publication
comparisons fail in face/edge references and lineage diagnostics. Public CI and
the narrower one-edit private oracle do not close that gate. Whole-worker
retention and the proposed detached Text record remain unaccepted; H02 is Partial.

The [public two-box reproduction](qa/2026-10-21/h02-m5-pro-qualification.md#public-reproduction-of-demand-history-dependent-publication)
isolates eager-to-idle lineage checkpoint reuse as a cause of history-dependent
publication with unchanged raw B-rep bytes. Its manual strict publication check
fails; aligning the demand histories or restarting the adapter matches fresh.
This diagnostic does not replace any private acceptance comparison.

## H02 PR #805 M5 Pro candidate (2026-10-21)

[Six candidate-only matched arms](qa/2026-10-21/h02-pr805-m5-pro-qualification.md) record p95 exact completion 3,966.6 → 3,639.0 ms (8.3% lower under load), below the required 20%; enabled median rises 3,284.9 → 3,420.3 ms. Every enabled arm fails the unchanged fixed Text restore assertion. Private raw B-rep and normalized publication match through 80 edits, refusal recovery and actual worker restart, but retirement/replay-budget coverage remains unmet. Post-GC JS/embedder/backing observations stay separate from whole-worker retention. H02 remains Partial; these results do not accept the detached Text branch or supersede baseline samples.

## H02 prepared-transform M5 follow-up (2026-10-21)

[The fresh `64f07065` campaign](qa/2026-10-21/h02-64f07065-m5-qualification.md)
passes all six alternating M5 arms and fixed Text restore. Recorded-load p95
exact completion is 3,442.9 → 2,487.1 ms (27.8% lower), meeting the unchanged
≥20% target. The 80-edit private session passes all seven raw/publication and
four eviction comparisons, three replay-budget cycles, checkpoint retirement,
refusal/recovery and actual worker restart. All five local gates pass at the
same pinned head. Linux and earlier candidate samples remain separate. Quiet-host
and whole-worker retention acceptance remain open; the detached Text branch is
unimplemented and unaccepted. H02 stays Partial.

## Viewer frame work and diagnostics (2026-10-31, H02)

The investigation started from `3ecf53b7` and compared that unchanged viewer
with this candidate on Windows, an Intel Core i7-10750H, headed Microsoft Edge
156.0.4314.42, ANGLE / Intel UHD
Graphics / D3D11, a 1600 × 1000 viewport and DPR 1. The browser used the full
production renderer, including antialiasing, studio environment and shadows.
The supplied screenshot is a symptom reference; its exact project was not
available. Two synthetic workloads cover a box plus cylinder (about 1.8k
rendered triangles, nine model draw calls) and 32 cylinders arranged in a grid
(about 53.7k triangles, 70 model draw calls). All CAD, picking and worker code
runs normally; only the account API is stubbed.

The loop used a Vite dev site, the Advanced frame-rate panel, Chromium CPU
profiles, main-thread long tasks, and a separate browser timeline for forced
layout. It then repeated the same hover/orbit/wheel script against production
builds. Frame intervals include browser scheduling and presentation work;
CPU callback time includes scene preparation, model rendering, the view cube
and DOM labels, and is not GPU time. The baseline's full callback was measured
by an external animation-frame wrapper; the candidate also exposes it as
`cpuMs` on `oz:viewer.frame` and `cpu (frame)` in Advanced diagnostics.
The existing `cpu (render)` and model draw/triangle counts keep their meanings.

### Findings and implemented changes

| Finding                                                        | Cause and action                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unused handle chips cost every frame                           | `updateOffsetChip` queried panel selectors and measured the stage before finding that no handle existed. Resolve the rig first and return before layout work when it has no anchor. Keep the active-handle placement and obstacle rules. Avoid rewriting already-hidden pills. In the browser regression the unchanged viewer made 14 panel scans during the orbit; the candidate must make zero.                               |
| View cube rebuilt while its orientation was unchanged          | `projectCube` and its rounded triangle batches ran on every model frame, including hover and zoom. Retain the projection until orientation changes, then retain uploaded attributes until projection, palette, fonts, focus or eased hover changes. Ignore quaternion rounding below a cube displacement of 0.001 CSS pixels; accumulate real turns against the last drawn orientation. Viewport placement and DPR remain live. |
| Settled cube fills stepped away from their target              | A value equal to its target took the decreasing branch. Keep it fixed, and invalidate geometry on every actual change, including the final fade step and removal. Unit coverage proves settling and invalidation; browser stationary-hover checks pass on both baseline and candidate, so this is not evidence of a reproduced permanent idle-render loop.                                                                      |
| The diagnostic panel forced layout while measuring performance | Text updates preceded `offsetParent` reads, then Canvas font resolution forced layout even after moving those reads. Finish layout/style reads and graph drawing before changing text or idle attributes. Development timeline: 24 diagnostic-forced layouts / 221.8 ms → zero. Production timeline: 26 forced layouts / 255.2 ms → zero in the matched diagnostic-orbit capture.                                               |
| Existing CPU timing omitted overlays                           | Report full viewer-callback CPU time after cube and labels, alongside model render time. Preserve model draw counts before the cube resets `renderer.info`. Opt-in frame marks also report `renderMs` and combined cube/label `overlayMs`.                                                                                                                                                                                      |

### Production observations

The table reports mean full-callback CPU milliseconds. The small workload has
one baseline with the common full-callback wrapper and two candidate sessions;
a second baseline session independently records the frame-interval/timeline
comparison. The array has one session per variant. These are local samples,
not a hardware-independent FPS promise or a statistically established p95.

| Workload / interaction          | Baseline CPU ms | Candidate CPU ms | Observation                                                                              |
| ------------------------------- | --------------: | ---------------: | ---------------------------------------------------------------------------------------- |
| Two bodies, hover               |            4.31 |        2.79–2.80 | About 35% less callback CPU, including first-use frames.                                 |
| Two bodies, orbit               |            2.48 |        1.83–1.96 | About 21–26% less CPU.                                                                   |
| Two bodies, wheel zoom          |            2.45 |        1.54–1.66 | About 32–37% less CPU.                                                                   |
| Two bodies, diagnostics + orbit |            2.39 |        1.86–1.91 | About 20–22% less callback CPU; panel timer work is separately measured by the timeline. |
| 32 cylinders, hover             |            6.33 |             4.93 | About 22% less CPU.                                                                      |
| 32 cylinders, orbit             |            4.47 |             3.07 | About 31% less CPU.                                                                      |
| 32 cylinders, wheel zoom        |            4.12 |             2.90 | About 29% less CPU; display intervals remain much longer than CPU callbacks.             |

With diagnostics enabled on the small scene, frame-interval p95 changes from
33.3–33.6 to 25.1 ms and p99 from 50.0–50.1 to 33.4 ms. General tail improvement
is not established: on the array, diagnostic-orbit p99 rises from 38.1 to
46.4 ms, and zoom p95 stays 37.5 ms. The array's frame intervals remain far
above its roughly 3 ms callback cost. GPU execution, compositor/browser work
and automation scheduling have not been separated, so call this time outside
the measured JS callback rather than a proven GPU-only bottleneck.

First-hover shader setup still produces approximately 130–180 ms stalls in
the observed runs, dominated by WebGL program queries. An experiment using
`compileAsync` on the two reusable face-film materials did not reduce this
stall and was removed. It does not justify shipping broader shader warmup.
Development also shows large React work around settled-view updates that is
absent as a long task in the corresponding production gestures. Thumbnail
render/readback appears during the idle capture, separately from an idle
viewer that draws zero frames. Neither observation justifies a CAD history or
kernel-cache rewrite.

### Next optimization loop

1. Attribute first-hover program creation to the complete material variants
   actually used: face films, batched visible/hidden edges and body state.
   Test asynchronous preparation only for the measured variants. Accept it
   only after repeated cold-start/first-hover comparisons show lower stalls
   without moving a comparable delay into initial display, leaking programs,
   changing shader error reporting or delaying picks. Keep the normal
   first-use path as the fallback.
2. Split time outside the callback on the 32-cylinder workload using supported
   disjoint GPU timer queries and browser GPU/compositor traces. Compare
   diagnostics off/on, shadow refreshes, grid and edge passes on the same
   camera path. Investigate draw-call batching or compositing only when that
   evidence identifies them; keep tessellation, exact picking and visible
   quality unchanged.
3. Profile a large imported part and an active face/edge drag separately.
   Use `perf-face-drag-trace.spec.ts` for pointer → preview → accepted geometry
   → rendered-frame timing. The current camera-only CPU gains do not claim
   lower kernel/analysis latency or faster exact completion. Retain the last
   valid preview and exact acceptance contracts.
4. Qualify on the hardware/project behind the screenshot, at its actual DPR,
   plus Chromium and Firefox. Repeat alternating baseline/candidate sessions,
   include warm-up separately, and compare full-callback CPU, active frame
   p95/p99, long tasks and retained GL resources. Require correctness and
   idle sleep before accepting any absolute frame budget. WKWebView requires
   the separately authorized Apple Silicon workflow.

### Reproduction and regression coverage

The maintained opt-in `test/e2e/perf-viewer.spec.ts` records idle, hover,
orbit, wheel zoom and Advanced diagnostics + orbit, with raw frame samples,
CPU profiles, browser/GPU identity and a screenshot. Choose a fresh output
directory for each arm. It deliberately has no machine-specific FPS gate.
For example, in PowerShell (with Edge installed):

```powershell
# Terminal 1: full renderer and opt-in frame marks, live source iteration.
$env:VITE_E2E='1'; $env:OZ_PERF='1'
pnpm dev:web --host 127.0.0.1 --port 5173 --strictPort

# Terminal 2: reuse that exact server; artifacts stay outside the checkout.
$env:PLAYWRIGHT_PORT='5173'; $env:OZ_PERF='1'
$env:OZ_VIEWER_CHANNEL='msedge'
$env:OZ_VIEWER_PERF_OUT=Join-Path $env:TEMP 'viewer-candidate-01'
pnpm exec playwright test perf-viewer --workers=1 --headed
# Repeat into a different output directory with OZ_VIEWER_BODIES='32'.
```

For production comparisons, build with the same `VITE_E2E=1` and `OZ_PERF=1`
flags using top-level `pnpm build`, serve the output with `pnpm --filter
@openzcad/web preview --host 127.0.0.1 --port 5174`, and set
`PLAYWRIGHT_PORT=5174`. The performance flags retain the full renderer.
Run the same workload after each change; use a separate DevTools Performance
capture for layout/paint attribution so its overhead is not mixed into quiet
frame samples. Standard regression coverage includes cube buffer reuse and
all invalidation/settling edges, graph read/write order, full-frame versus
render-only timing, no handle-panel scans during orbit, and stationary hover.
Existing `viewer-steadiness.spec.ts` also covers active edge handles and
normal-to-face navigation. Raw captures stay outside the repository.

## First-hover shaders and large-scene spikes (2026-11-01, H02)

This follow-up compares the previous viewer pass (`cc07ba6`) with the highlight,
ruler and guidance-selector fixes on the same local machine. The target was a
2x improvement where measurable, not a claim that every operation becomes twice
as fast. Full rendering, exact geometry, tessellation and visual settings stayed
enabled. These are local measurements, not production-site verification.

### Causes and changes

- **First hover:** the 32-cylinder trace linked five new programs and spent
  168.2 ms in shader/program diagnostic calls during hover. The visible and
  hidden face films need front/back variants; the hidden edge pass adds another
  line variant. Empty highlight-slot geometry had previously warmed different
  program keys: missing position/normal attributes and flat-shaded Lambert.
  Highlight preparation now supplies the actual attribute flags, keeps six
  material owners for the renderer lifetime, and covers both sides explicitly.
  Three's async readiness check tracks only the current program of each
  material, so distinct side owners also make both passes participate in it.
- **Deferred driver work:** parallel linking alone still leaves shader
  diagnostics and uniform reflection until first use. Empty-buffer preparation
  passes initialize those without submitting GL draws, clears or shadow work.
  Reflection yields between variants rather than forming one large startup
  task. Renderer clear/shadow state is restored after each pass, pending work
  stops on disposal, and body rebuilds do not evict the retained programs.
- **Zoom layout:** changing the ruler length replaced identical output text
  twice per redraw. Those child-list mutations invalidated a placeholder rule
  querying activity and guidance across the workspace. The ruler now retains
  unchanged label nodes, accessible labels and bitmap dimensions. When a bitmap
  is reused it clears its entire backing surface before drawing again.
- **Diagnostic spikes:** genuine numeric changes still triggered broad
  invalidation through that rule. Guidance presence now comes from the readout's
  render state; the activity query stays on its own lane. This preserves the
  pill/hint/placeholder behavior while removing the viewer-wide invalidations.
- **Honest diagnostics:** a self-scheduled animation's gaps above 250 ms now
  remain in the history, percentiles, lows and hitch count. Rest between gestures
  and browser visibility pauses remain excluded. A long callback is not reported
  as idle immediately after it finishes. Raw performance marks include animation
  continuity, and the opt-in probe records slow shader calls and startup phases.

### Matched results

Headed Edge 156, Intel UHD/D3D11, a 1600x1000 CSS viewport and DPR 1 were used for
both arms. Antialiasing, environment, shadows and the model's draw load were
unchanged. The two quiet 128-cylinder repeats alternated baseline/candidate;
neither CPU profiling, GPU queries nor timeline recording ran during those
measurements. Separate attribution runs used identical tracing/query settings
in both arms. The 128-body scene submits about 215k rendered triangles, with
261–262 model-scene draws and 277 geometries in both arms.

| Workload | Baseline | Candidate | Interpretation |
| --- | ---: | ---: | --- |
| 32 bodies, traced hover shader diagnostic time | 168.2 ms; 5 links | no call above 0.3 ms; 0 links | Prepared programs reused on first hover |
| 32 bodies, traced worst hover callback | 150.1 ms | 11.1 ms | 92.6% less callback time at the worst sample |
| 32 bodies, traced zoom p99 | 75.0 ms | 33.3 ms | 55.6% lower tail latency |
| 32 bodies, traced diagnostics-orbit p99 | 75.1 ms | 41.9 ms | 44.2% lower tail latency |
| 32 bodies, quiet repeat zoom mean / p99 | 35.6 / 79.2 ms | 17.9 / 37.5 ms | About 2x throughput; 52.7% lower p99 |
| 128 bodies, quiet A zoom mean / p99 | 81.2 / 141.7 ms | 19.4 / 50.1 ms | 4.18x throughput; 64.6% lower p99 |
| 128 bodies, quiet B zoom mean / p99 | 75.7 / 104.2 ms | 19.6 / 54.2 ms | 3.85x throughput; 48.0% lower p99 |
| 128 bodies, quiet A diagnostics-orbit p99 | 95.9 ms | 58.5 ms | 39.0% lower tail latency |
| 128 bodies, quiet B diagnostics-orbit p99 | 100.0 ms | 54.2 ms | 45.8% lower tail latency |

The traced 32-body zoom spent 4,805.6 ms in layout before and 105.2 ms after
(97.8% less across the phase); the worst layout fell from 63.7 to 2.3 ms.
Diagnostics-orbit layout fell from 1,062.8 to 195.2 ms, with zero broad
placeholder invalidations after the fix. Quiet 32-body diagnostics-orbit p99
was unchanged at 58.3 ms in one repeat, and its mean regressed from 20.4 to
23.3 ms. Ordinary orbiting improved less than zoom. These results do not establish
a universal 100% performance improvement.

There is still cold startup work: the final traced preparation took 395.7 ms
including asynchronous linking and scheduling. Six reflection tasks took
0.5–37.1 ms each, rather than the earlier single 158.8 ms preparation block.
The renderer's first model frame presents before preparation starts; an
interaction arriving before preparation completes can still encounter cold work.
The visible-render improvements are not a reduction of all shader compilation.

All six quiet production captures completed without page/console errors. The
existing D3D11 X4122 shader precision warning remained; shader diagnostics were
not disabled. Dev captures also exercised the changed code through hot reload.
Some contained HTTP 401 console entries and failed the capture's strict error
assertion; the production-bundle captures are the error-free browser evidence.

### Regression coverage and next measurements

The focused suite covers program attributes and side readiness, retained-owner
disposal, cancellation before/during/between preparation tasks, restoration on
failure, unchanged ruler nodes/bitmaps, guidance state, long stalls and visibility
pauses. Browser regressions assert **zero GL draw/clear commands during
reflection passes**, reuse on real face/edge hover after another exact body is added,
and the activity pill's placeholder/hint behavior. Existing handle, cube and
normal-to-face regressions remain required.

The maintained probe accepts `OZ_VIEWER_BODIES=2`, `32` or `128`. Use the preceding
reproduction instructions with a fresh external output directory for every arm;
`hover.json` now includes slow main-viewer shader calls and `summary.json` includes
startup preparation/reflection timings. Keep quiet samples separate from traces.

Local verification: 5,015 web tests across 465 files and 220 parity tests pass
(one parity skip); the focused viewer/lifecycle set has 48 passing tests. Lint
has zero errors and 18 existing warnings; typecheck and the full build/bundle
gate pass. The complete Windows root run remains failed: 8,739 passed, 41 failed,
51 skipped, across the same 15 previously failing files. A four-file immutable
prior-commit control reproduces two partial-revolve failures with 93 passing
tests; it does not individually establish the cause of all 41 root failures.
No backend/kernel assertion was changed to accommodate them.

Next work should follow the remaining bottleneck rather than apply a global
quality reduction:

1. Collect denser disjoint-safe GPU samples of the floor grid and gradient
   backdrop. Sparse draw samples suggest roughly 2–4 ms for the grid and 2–3 ms
   for the backdrop, versus tens of microseconds per individual body/edge draw;
   those samples are attribution clues, not a stable GPU acceptance baseline.
2. Profile the remaining diagnostic text layout on very large object/history
   trees. Layout containment alone did not establish an independent layout root
   in the measured browser and was removed. Preserve panel sizing, drag,
   collapse, fonts and accessible values in any replacement.
3. Measure cold preparation separately from first hover, including input arriving
   before readiness and drivers without parallel compilation. Keep both
   preparation duration and its largest main-thread task visible.
4. Add imported assemblies and direct face/edge editing workloads. This pass
   measures camera/hover rendering and generated cylinder arrays; it does not
   qualify million-triangle imports, kernel recomputation or every CAD gesture.
5. Repeat on target GPUs and display/DPR settings before setting an absolute FPS
   gate. Preserve on-demand idle sleep and report CPU, GPU and frame intervals
   separately. H02's broader geometry/cache acceptance remains Partial.

## Cold shader diagnostics and orbit tails (2026-11-01, H02)

This pass uses `7f6391ab` as its comparison point: the preceding highlight,
ruler and guidance fixes are already present. Headed Edge 156, Intel UHD/D3D11,
1600x1000 CSS pixels and DPR 1 were kept in both arms. The preserved baseline
bundle and the candidate used full rendering, identical GLSL and exact meshes.
Both submitted 261–262 draws and 214,550–214,552 rendered triangles during orbit.
These are local measurements, with two alternating final baseline/candidate
pairs and additional isolated cold-start repeats.

### Causes and implementation

1. Three's first-use diagnostic path synchronously queried the program log and
   both shader logs even after asynchronous linking completed successfully.
   Several individual log queries blocked for tens of milliseconds. Three
   remains at 0.186.1 through `pnpm.patchedDependencies`; the patch covers the
   browser ESM entry and corresponding source. Clean links avoid individual
   shader-log queries; failed links and nonempty program warnings retain their
   detailed shader logs. The CommonJS bundle is unchanged.
2. The six known highlight preparation passes also avoid successful-program
   warning-log round trips unless a caller explicitly enables
   `renderer.debug.checkShaderWarnings`. Link status and full failure diagnostics
   remain enabled. That optional preference is restored after each pass, including
   failures. Normal model/environment warning handling remains unchanged. The
   existing D3D11 X4122 warning appeared in every final capture in both arms.
3. The frame-rate panel replaced its numeric Text nodes every 250 ms. Keeping
   those nodes and changing character data avoids structural invalidation of
   ancestor selectors. The readouts and accessible values continue to update.
4. An occasional remaining spike came from a status toast disappearing:
   `--lane-status` changed on the whole viewer and restyled about 13,000 elements.
   Only the action toast and refusal lane consume it, so its declarations now
   live on those consumers. Browser checks preserve offsets for running status,
   activity, commands, combined notices and settled undo messages, while model
   rows no longer inherit that changing height.

The shader query change follows the failure-first approach in the
[KHR parallel compilation guidance](https://registry.khronos.org/webgl/extensions/KHR_parallel_shader_compile/).
It does not change shader source or successful rendering. Successful individual
shader logs with an empty program log are no longer gathered eagerly; detailed
failed-program diagnostics, custom error callbacks and program warnings have
focused regression coverage. A real deliberately invalid highlight shader also
still reports its compiler error and offending source in the dev site.

### Final matched measurements

Quiet runs used no CPU profiler, timeline capture or GPU timer queries. Each
orbit starts on unobstructed canvas and asserts that the camera actually moved.
Each gesture contains the same 180 input moves; long-task counts are per gesture
and use the browser's 50 ms threshold, distinct from the HUD's 25 ms hitch count.

| Measurement | Baseline A → candidate A | Baseline B → candidate B |
| --- | ---: | ---: |
| Largest cold highlight reflection task | 127.1 → 14.4 ms | 39.9 → 0.8 ms |
| Entire highlight preparation span, including async waits | 702.4 → 524.5 ms | 900.4 → 308.1 ms |
| Diagnostics-orbit mean frame interval | 22.0 → 17.3 ms | 19.5 → 19.5 ms |
| Diagnostics-orbit p99 | 66.7 → 54.0 ms | 67.2 → 50.0 ms |
| Diagnostics-orbit worst frame interval | 116.6 → 75.0 ms | 91.5 → 58.5 ms |
| Diagnostics-orbit browser long tasks | 35 → 2 | 28 → 1 |
| Ordinary orbit mean frame interval | 17.5 → 16.7 ms | 17.1 → 16.6 ms |
| Ordinary orbit p99 | 37.7 → 41.9 ms | 42.3 → 37.7 ms |

All four final captures had zero page/console errors. Separate paired cold-start
checks measured largest tasks of 37.9 → 1.2 ms and 41.9 → 8.1 ms. Ordinary orbit
tails remain variable; one repeat regresses, and zoom means also vary. These
results establish the cold-highlight and diagnostic-spike improvements, not a
universal FPS multiplier or stall-free startup. Initial environment/model shader
compilation remains outside the improved highlight-preparation path.

Attribution traces separated the causes: stable readout nodes reduced periodic
style work from 1,657.6 to 232.9 ms and layout from 895.1 to 266.9 ms across a
diagnostics-orbit phase. A later notice-scope trace reduced the largest style
update from 99.6 to 53.2 ms and its largest restyled set from 13,095 to 2,166
elements. Traces have overhead and are not the quiet acceptance numbers above.
GPU-fence and layout-containment experiments did not deliver a consistent
production improvement and were left out.

### Reproduction and remaining work

The maintained `perf-viewer.spec.ts` now retains startup shader calls, includes
slow program-parameter queries with their parameter IDs, waits for preparation
completion, and checks orbit targeting and camera movement. Set
`OZ_VIEWER_CPU_PROFILE=0` with the existing `OZ_PERF=1`, `OZ_VIEWER_BODIES=128`
and external `OZ_VIEWER_PERF_OUT` settings for quiet runs; leave profiling enabled
for attribution. Use fresh output directories and alternate baseline/candidate.

Keep the next pass focused on the remaining first environment/model draw and
ordinary-orbit outliers. Separate shader work, GPU/compositor waits, one-time
notice transitions and sustained gesture frames before choosing a fix. Repeat
on other GPUs/DPR settings and imported assemblies, and measure refused direct
edits before extending the variable-scope change to other notice heights. H02's
broader geometry/cache acceptance remains Partial.
