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
source mesh buffers are never transferred or detached. The hook keeps one request
in flight and then sends the newest waiting source.
Every completed reply is cached and can advance the displayed geometry, even if
another tick is waiting; an older result cannot rewind a newer display. Unchanged
body objects retain their weakly keyed readiness across ticks. Appearance-only
replacements carry the displayed body's preparation over synchronously when
`sameBodyRenderGeometry` and `sameBodyPickingTopology` both pass. Colour/name
changes therefore publish the new appearance, selection and handles on the same
render without copying a dense mesh to the worker. First open and
body-ID set changes (add/merge/split/delete/undo) prepare synchronously, so they
never blank the scene for a worker round trip. Other replacements hold the most
recent ready body set together with its selection/highlight/handle props. Revision
readiness waits for the actual current replacement to be installed.
Large facet references retain their existing direct-upload path. A worker
error, message-deserialization error, malformed/error reply, failed post or
five-second in-flight timeout terminates the worker and restores the synchronous
renderer. Input churn does not restart that timeout. Every fallback emits
`oz:viewer.preparation-fallback` with a `detail.reason` of `timeout`, `error`,
`messageerror`, `bad-reply`, `post-failure`, or `construction`. The opt-in face-drag
trace records the same reason in the `prepare-fallback` event's `message`.

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

## Preparation memory

Installed geometry keeps separate position, normal, index and coplanar-depth
buffers. Directly sharing a cached result is unsafe: `updateObjectForBody` rewrites
positions/normals and `applyCoplanarBodyDepthSlots` rewrites depth values (and can
expand the geometry). After a new mesh is installed, existing buffers are updated,
or the viewer retains an unchanged mesh, the cached `geometry` field is deleted.
This releases its duplicate position/normal/depth/index arrays and its outline and
smoothing-layout references. All appearance aliases share that cache entry, so
release applies to all of them. A later restoration rebuilds from the document
instead of reusing mutated installed buffers.

The weak entry remains as a readiness marker for appearance carry-over. Tangent
IDs and silhouette candidates remain available to the edge overlay; the installed
silhouette state shares those candidates rather than duplicating their cache
storage. The cached/transferred smoothing layout no longer includes the unused
`normalSums` Float64Array: only installed geometry owns that scratch buffer.
Pending preparations still hold staging arrays until installation or collection;
source mesh/topology cloning and the temporary installation copies remain. This
is an ownership change covered by identity/cache assertions, not a measured new
peak-RSS or frame-time claim.

## Main integration

Merged `origin/main` at `0860905255a9d45ba1c8e8f65965960d27f840f9` (#1315)
with a merge commit, without rebasing. The ModelViewer conflict combines the
`incomingOffsetHandle` preparation snapshot binding with the separate semantic
`offsetDragTarget`. The displayed-face handle anchoring, `resetBodyPickingRef`
reset on proxy restoration/exact replacement, #731 last-valid retention,
plain `useEffect` ordering and retire-only-on-target-change drag logic survive.
`App.tsx` and `edgeOverlay.ts` merged automatically; their combined changes were
inspected. No auto-merge or PR watch is enabled.

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

## Historical local results (before this rework)

Two runs per scenario/build, on baseline `68ffc56e` and the original PR
implementation (`ed850fb7`, before the fixes described above). The
[recorded summary](face-drag-results.json) retains **every repeat**, including
adverse results. Times are milliseconds, and ranges span the two runs.

| Measurement                                      |      Before |     After |
| ------------------------------------------------ | ----------: | --------: |
| Inward surrogate: main-thread exact installation | 188.5–267.7 | 25.2–57.5 |
| Inward surrogate: React commits                  |     132–133 |     11–13 |
| Long history: main-thread exact installation     | 281.9–430.3 | 84.4–88.7 |
| Long history: React commits                      |         122 |     10–11 |

These **installation-only** timings exclude the main-thread structured clone
performed by `Worker.postMessage`. They are not total main-thread preview costs.
The rework instruments that call as `prepare-post` in the OZ_PERF face-drag trace
(and `oz:viewer.preparation-post` in User Timing); `stages.preparationPostMs`
reports it separately from `stages.installMs`. First-open/structural synchronous
preparation also occurs before installation. Historical runs did not measure
copy time, so it cannot be reconstructed or subtracted from these figures.

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

## Rework copy-cost sample

The first rework OZ_PERF sample ran once per scenario, on the same host
and ANGLE RTX 3090 OpenGL renderer. The [rework summary](face-drag-rework-results.json)
retains all four runs, including the adverse frame statistics. This is a single
candidate sample, not a clean new before/after frame-timing comparison. The
post totals include settle/release; installation statistics cover motion. Each
run exposed a redundant empty third post, subsequently removed by rechecking
the cache in the passive effect (covered by a hook regression).

| Scenario         |  Main-thread preparation post/copy | Installation only | React commits |
| ---------------- | ---------------------------------: | ----------------: | ------------: |
| Inward surrogate | 6.8 ms total (3 posts; 3.6 ms max) |           22.8 ms |            13 |
| Long history     | 5.6 ms total (3 posts; 3.1 ms max) |           19.8 ms |            10 |

The final candidate was then sampled once per scenario after removing the empty
post. Both scenarios passed; each now has two nonempty posts across motion and
settle/release. Copy cost varied substantially under contention, so the higher
final samples are retained too:

| Scenario                 |    Main-thread preparation post/copy | Motion installation only | React commits |
| ------------------------ | -----------------------------------: | -----------------------: | ------------: |
| Inward surrogate (final) | 20.1 ms total (2 posts; 15.5 ms max) |                  45.1 ms |            11 |
| Long history (final)     |   8.8 ms total (2 posts; 4.4 ms max) |                  91.7 ms |            12 |

The post measurement brackets the actual `Worker.postMessage` call without a
transfer list: it includes synchronous structured cloning and enqueueing, but
excludes worker-side deserialization/preparation and the later render-array/GPU
installation. Installation alone understates the main-thread work. Do not add
these samples to historical medians: they are separate runs with different host
contention. Host sampling during rework showed active swap I/O (about 10 MiB/s
swap-out in one interval) and many other validation processes. **FPS, p99 and
hitch improvement remain unproven.**

```bash
PLAYWRIGHT_PORT=24671 OZ_PERF=1 OZ_FACE_DRAG_ANGLE=gl \
  OZ_PERF_OUT=/tmp/pr1317-copy-cost.jsonl pnpm exec playwright test \
  perf-face-drag-trace --grep 'width from 30|long native history' --workers=1
```

## Original regression evidence (before this rework)

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

## Earlier rework verification

- Typecheck passed. Changed-file ESLint passed with the existing ModelViewer
  `exhaustive-deps` warning (zero errors); no assertion or protection was weakened.
- Focused web Vitest: 25 passed, including 15 preparation-hook cases covering
  retained dense A, intermediate replies, synchronous/nonblank body-set changes,
  displayed selection/handle snapshots, all fallback paths, cleanup, post tracing
  and a cache fill between render and the passive effect.
- Focused root Vitest: 74 passed, including a trace regression that keeps
  preparation-post cost separate from installation and includes release posts.
- `pnpm build` passed artifact provenance and bundle-size checks. The first
  sandbox build lacked Git provenance and failed closed; host-mode serial
  reruns passed. One overlapping probe startup was stopped and rerun serially.
- Full relevant browser specs: **10 passed, 3 failed**. The failing cases at
  `face-drag-continuity.spec.ts:550`, `:590`, and `:680` all time out waiting for
  the `slowAnalysis` helper's injected `held > 0` witness, before their continuity
  assertions. All three reproduce at the same assertions on the original
  `20b30878b9fd731b4eca4d31b3e6d96cf548c2ad` head, exported to a separate temporary
  tree with the same installed dependencies and one browser worker. They remain
  existing verification limitations; this PR does not alter or weaken them.
- Final OZ_PERF browser probe: both scenarios passed.
- Git privacy guard and roadmap-evidence validation passed.

Exact commands (from the repository root unless noted):

```bash
pnpm typecheck
pnpm exec eslint apps/web/src/components/ModelViewer.tsx apps/web/src/components/viewer/bodyPreparationWorker.ts apps/web/src/components/viewer/prepareBody.ts apps/web/src/components/viewer/usePreparedBodies.ts apps/web/src/components/viewer/usePreparedBodies.test.tsx apps/web/src/lib/faceDragTrace.ts test/face-drag-trace-summary.test.ts test/support/faceDragTraceSummary.ts
pnpm --filter @openzcad/web exec vitest run src/components/viewer/usePreparedBodies.test.tsx src/components/viewer/interactionShaderWarmup.test.ts src/components/viewer/previewShaderSamples.test.ts src/hooks/usePreviewVerdict.test.tsx --maxWorkers=1
pnpm exec vitest run test/face-drag-trace-summary.test.ts packages/viewport/src/render/bodyUpdate.test.ts packages/viewport/src/render/smoothingParity.test.ts packages/viewport/src/render/edgeOverlay.test.ts packages/viewport/src/render/silhouette.test.ts packages/viewport/src/render/tangentEdges.test.ts --maxWorkers=1
pnpm build
CI=1 OPENZCAD_E2E_SUITE=full PLAYWRIGHT_PORT=24671 pnpm exec playwright test generic-face-drag-preview face-drag-continuity --workers=1 --retries=0 --reporter=line
node scripts/roadmap-evidence.mjs
~/.local/bin/git-privacy-guard verify --repo .
```

Baseline reproduction, from the unmodified exported original-head tree:

```bash
OPENZCAD_BUILD_COMMIT=20b30878b9fd731b4eca4d31b3e6d96cf548c2ad CI=1 OPENZCAD_E2E_SUITE=full PLAYWRIGHT_PORT=24672 pnpm exec playwright test face-drag-continuity --grep 'committed face stays selected|commit reads as complete|applying a fillet goes straight' --workers=1 --retries=0 --reporter=line
```

## Follow-up review verification after main integration

Validated the merged code tree at `ac1afef5840b7ebe33ddef847ce95ba654730e3b`;
subsequent edits only update this note and its roadmap evidence fragment.

- PASS: Node 22 typecheck. The initial Node 24 attempt crashed with `SIGSEGV`
  without a TypeScript diagnostic; serial Node 22 runs passed before and after
  merging main.
- PASS: changed-file ESLint, zero errors and one existing ModelViewer
  `exhaustive-deps` warning.
- PASS: focused web Vitest, 43 tests across six files, including #1315's
  `useOffsetFaceHandle` and `ModelViewer.lifecycle` suites. New hook cases assert
  same-render colour/name and presentation updates with no worker post after
  staging-array release; a picking-only change still requires preparation.
  Existing fallback cases now assert both the performance mark and drag-trace
  reason for timeout, error, message error, bad reply and post failure.
- PASS: focused root Vitest, 75 tests across six files. Installation assertions
  verify absence of cached `normalSums`, release of geometry arrays through all
  appearance aliases, isolated installed buffers and release after in-place
  updates. Smoothing/restoration and edge-overlay tests remain passing.
- PASS: `pnpm build`, including immutable Remus bytes, production Vite build,
  provenance and bundle-size checks.
- Browser command FAIL: 14 passed, 3 failed (17 total, one worker, no retries).
  Both `generic-face-drag-preview` cases passed. The three continuity failures
  are at `face-drag-continuity.spec.ts:678`, `:718`, and `:808` (assertions at
  `:709`, `:772`, `:859`): `slowAnalysis.held` remains zero before the continuity
  assertions. These match the baseline failure signature documented above and
  in #1315; this follow-up did not repeat the baseline run or weaken assertions.
  The newly merged retained/committed handle-anchor and cancellation cases passed.
- PASS: roadmap-evidence validation and `git diff --check`.

Exact follow-up commands (repository root; Node 22 selected via PATH):

```bash
PATH=/usr/bin:$PATH pnpm typecheck
PATH=/usr/bin:$PATH pnpm exec eslint apps/web/src/components/ModelViewer.tsx apps/web/src/components/viewer/usePreparedBodies.ts apps/web/src/components/viewer/usePreparedBodies.test.tsx apps/web/src/lib/faceDragTrace.ts packages/viewport/src/render/preparedBody.ts packages/viewport/src/render/scene.ts packages/viewport/src/render/bodyUpdate.test.ts
PATH=/usr/bin:$PATH pnpm --filter @openzcad/web exec vitest run src/components/viewer/usePreparedBodies.test.tsx src/components/viewer/interactionShaderWarmup.test.ts src/components/viewer/previewShaderSamples.test.ts src/hooks/useOffsetFaceHandle.test.tsx src/components/ModelViewer.lifecycle.test.tsx src/hooks/usePreviewVerdict.test.tsx --maxWorkers=1
PATH=/usr/bin:$PATH pnpm exec vitest run test/face-drag-trace-summary.test.ts packages/viewport/src/render/bodyUpdate.test.ts packages/viewport/src/render/smoothingParity.test.ts packages/viewport/src/render/edgeOverlay.test.ts packages/viewport/src/render/silhouette.test.ts packages/viewport/src/render/tangentEdges.test.ts --maxWorkers=1
PATH=/usr/bin:$PATH pnpm build
CI=1 OPENZCAD_E2E_SUITE=full PATH=/usr/bin:$PATH pnpm exec playwright test generic-face-drag-preview face-drag-continuity --workers=1 --retries=0 --reporter=line --output=/tmp/pr1317-followup-playwright
node scripts/roadmap-evidence.mjs
git diff --check
```

No new timing or peak-memory benchmark was run. Full lint and other Playwright
specs were excluded to respect the host-memory and verification scope.
