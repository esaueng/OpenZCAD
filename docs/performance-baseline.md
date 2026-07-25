# Startup performance baseline

Findings from investigating the QA report's P-01, P-02, and P-03. The headline
conclusion is that **the slow startup phases are not application JavaScript**,
so the obvious optimisations would have moved nothing.

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

## What the numbers say

Every instrumented main-thread phase is small and stable:

| Phase | Typical |
|---|---:|
| `worker.create` | <1 ms |
| `document.hydrate` | <1 ms |
| `viewer.init` (whole scene setup) | 38–52 ms |
| `viewer.environment` (PMREM studio map) | 26–31 ms |
| `viewer.firstFrame` (first `renderer.render`) | 17–20 ms |
| `viewer.bodies` (geometry → three.js objects) | 3 ms |

Against that, a single **~800–900 ms main-thread block** appears once per
session. A CPU profile attributes it almost entirely to V8's `(program)`
bucket — time spent *outside* JavaScript, i.e. GPU/driver work, rasterisation
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
537 ms on the *first* headed run, before that cache existed. The QA report's
figures came from headless runs, so they overstate what a user on a GPU sees.
**Re-baseline on target hardware before optimising this.**

### P-01 — existing-document reload

Not reproduced. The probe's reload returns to the start screen rather than
restoring the workspace, so the report's 3,551 ms exact-document reload path
was never exercised here. It needs a durable project against the real API.

### P-03 — bundle size

The 22 MB OCCT and 4.75 MB BrepKit WASM **are never fetched** during project
creation, primitive creation, or boolean operations — they load only for
STEP/OCCT work. Initial load is `index.js` (457 kB), `three.js` (554 kB) and
CSS (59 kB): ~289 kB gzipped. The kernels are already correctly lazy; the
remaining work is delivery (immutable caching, compression), not code
splitting.

## Actionable finding: render-blocking web font

`apps/web/index.html` loads Google Fonts as a render-blocking stylesheet in
`<head>`. It consistently takes **179–220 ms** and starts at ~11 ms, against a
first contentful paint of 236–288 ms — so it is on the critical path for every
cold visit, on real hardware as much as in CI.

Unlike the GPU warm-up, this one is unambiguously worth fixing: self-host the
two families, or load them non-blocking and accept a font swap.
