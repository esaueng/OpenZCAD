# Face-drag main-thread work

The repeatable probe is `test/e2e/perf-face-drag-trace.spec.ts`. Its inward
case moves the public filleted-union fixture's right face from 30 to 22.5 mm
with 120 moves, spaced by 16 ms, then releases and waits for the authoritative
ready frame. This is a **surrogate**, not a reconstruction of the recording:
the public fixture has an R5 junction band and a later height edit; the
recording's three fillet sets and chamfer edge selections were not supplied.
The existing 25-feature union case stresses the same rendering path with a
longer history. `OZ_FACE_DRAG_PROJECT` supports a supplied native backup.

## Diagnosis and changes

Main-thread CPU profiles identified synchronous angle-weighted smoothing,
tangent classification and curved-outline candidate construction during exact
body installation. The long-history baseline spent 282–430 ms installing an
exact preview. The kernel itself executes in the existing geometry worker;
its time is reported separately, not presented as main-thread work.

Dense bodies (over 20,000 triangles) now prepare those same algorithms in a
lazy viewport worker. Replies carry disposable typed render arrays; the
source mesh buffers are never transferred or detached. Superseded replies
cannot install. The viewport holds its previous input set while a replacement
prepares, and withholds revision readiness until the actual replacement is
installed. Caches retire with the input set. Installed GPU attributes are
separate copies, so a later in-place update cannot poison restoration.
Large facet references retain their existing direct-upload path. A worker
failure retains the synchronous renderer.

A second source of work was the global React preview-verdict state: every
drag tick rendered the workspace and its panels although only the closed
keypad consumed that state. The verdict store now subscribes only while entry
is open, retaining the exact latest value/status when entry opens. This covers
face, radius and blend verdicts without changing refusal decisions or text.

The first cold ghost draw also blocked in `getProgramParameter` (1,044 ms
sampled in one cold hardware run). The existing asynchronous interaction-shader
warmup now includes the real ghost and clipped pull variants using tiny sample
geometry and zero-draw reflection. Renderer-owned materials retain these
programs until renderer disposal. No ghost pass is removed: the depth/fill/rim
passes deliberately describe the old shape and proposed added material.

## Reproduction

Build and serve the same revision for both runs:

```bash
VITE_E2E=1 OZ_PERF=1 pnpm build
pnpm --filter @openzcad/web preview --host 127.0.0.1 --port 24659
OZ_PERF=1 OZ_FACE_DRAG_ANGLE=gl PLAYWRIGHT_PORT=24659 \
  OZ_PERF_OUT=/tmp/face-drag.jsonl pnpm exec playwright test \
  perf-face-drag-trace --grep 'width from 30|long native history' \
  --workers=1 --repeat-each=2
```

Linux GPU acceleration is explicit: the measured renderer was ANGLE OpenGL
on an RTX 3090, at 1440 × 1000 and DPR 1. The default headless SwiftShader run
was diagnosed and excluded. `OZ_FACE_DRAG_PROFILE=/tmp/profiles` records main
CPU samples; `OZ_FACE_DRAG_TIMELINE=/tmp/traces` records a Chrome timeline.
Neither is needed for routine repeats. Production render quality stays on.
The output retains raw frames and long tasks, and splits motion from
settle/release. Frame interval percentiles and >25 ms hitches include only
continuous frames, excluding intentional idle gaps. These are local,
shared-host measurements, not the recording's device or a 90/120 Hz guarantee.

## Local results

Two runs per scenario/build, on baseline `68ffc56e` and this change. The
[recorded summary](face-drag-results.json) retains **every repeat**, including
adverse results. Times are milliseconds, and ranges span the two runs.

| Measurement | Before | After |
| --- | ---: | ---: |
| Inward surrogate: main-thread exact installation | 188.5–267.7 | 25.2–57.5 |
| Inward surrogate: React commits | 132–133 | 11–13 |
| Long history: main-thread exact installation | 281.9–430.3 | 84.4–88.7 |
| Long history: React commits | 122 | 10–11 |

A separate profiled long-history run installed in 20.2 ms, with motion-frame
CPU p95 13.7 ms and max 24.4 ms. It is diagnostic evidence, not substituted
for the repeated-run range above. The main-thread profile no longer runs
smoothing and silhouette construction during installation.

**Overall frame timing was inconclusive.** The host exhausted available RAM
and heavily swapped during final repeats (the required lint process was
killed with exit 137). The last repeat contains a 102,761 ms long task and
42,064 ms release-to-frame wait. Even the inward motion-frame CPU p95 went
from 11.4–13.7 ms before to 53.4–113.6 ms after under that contention. These
results cannot support a claim that p99, hitch counts, worst frame or FPS
improved on the recording's device. The attributable reductions above are
installation work and workspace commits, not an end-to-end responsiveness
guarantee. The exact kernel still took 1.3–2.6 seconds in its **worker** in
those final repeats; this change does not optimize that WASM computation.

## Regression evidence

- Web Vitest: 65 tests passed (verdict subscriptions, worker handoff/stale
  replies/fallback, shader warmup, preview shader samples, NumericKeypad).
- Viewport Vitest: 63 tests passed (smoothing/prepared-buffer parity and
  restoration, edge overlays, silhouettes, tangent classification).
- Parity corpus: 92 passed, one existing skipped case.
- Browser: generic imported drag, typed ghost preview, refusal continuity,
  typed offset continuity, and both short/long-history filleted-union
  undo/redo/reload journeys passed. Two initial generic tests reached their
  local 5-second restoration timeout before dragging; retrying with the
  repository's 30-second CI readiness budget passed both.
- Production build and bundle-size/provenance checks passed; the lazy viewport
  worker is about 324 kB raw and stays inside the existing budget.
- Typecheck passed. Full lint initially exited 137 under host memory pressure;
  delivery status records the recovery attempt separately.
