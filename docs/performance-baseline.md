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

## Interaction baseline

Reproduce with:

```bash
OZ_PERF=1 pnpm exec playwright test interaction-probe
```

The probe opens the Heat Sink demo, the existing model with the busiest edge
set, then drives a left-button orbit and right-button pan for about five
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
empty project does not import the exact adapter/BrepKit. (OCCT was a second
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
> | Measure | Before Z5 | After Z5 | Delta |
> | --- | ---: | ---: | ---: |
> | `assets/index-*.js` raw | 400,750 B | 400,429 B | −321 B |
> | `assets/index-*.js` gzip | 114,840 B | 114,690 B | −150 B |
> | All reported assets, raw | 10,174,485 B | 10,174,164 B | −321 B |
> | `apps/web/dist` on disk | 12,292,594 B | 12,292,273 B | −321 B |
> | Files matching `occt`/`opencascade` | 1 | **0** | — |
>
> So the honest accounting is: Z3 banked 22,088 kB; Z5 banks 321 bytes and the
> property that the shipped bundle contains no OpenCascade at all. What Z5
> actually recovers is source, not payload — see the Z5 entry in
> `docs/kernel-execution-plan.md` for the line counts.

The three eager UI assets total about 362.9 kB gzip. PDF worker/runtime assets
are emitted separately and are loaded only when reference-document support is
used. Reproduce the complete raw/gzip inventory with `pnpm build:report`; the
script reports every JS, CSS, and WASM asset instead of depending on hashed
filenames in this document.

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

1. cold first non-empty rebuild, including `loading-brepkit`;
2. warm identical-document cache hit;
3. canonical edit miss versus derived-only hit;
4. eviction latency after 8+ representative documents;
5. retained worker heap with large embedded STEP sources; and
6. BrepKit first-load time for a STEP document (this used to read "OCCT";
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
