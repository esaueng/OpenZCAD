# Interaction-feel refinement plan — 2026-08-12

Companion to `interaction-feel-audit-2026-08-12.md` (defect numbers below
reference its inventory). Goal: make modeling interaction feel like
mainstream CAD — no hitches on gesture start, geometry that tracks the hand,
transitions instead of pops, and instrumentation that keeps it that way.

## Status (2026-08-13)

Branch `claude/3d-modeling-interface-refinement-e7b650`.

| Item | State |
| --- | --- |
| 0.1 phantom hover batches | **done** — `27f3483`, frame p50 24.9 → 16.7 ms |
| 0.2 probe scenarios + commit counter | **done** — `ba36034` |
| 0.3 baseline captured | **done** — `docs/performance-baseline.md` Wave 4 |
| 1.1 memoize viewport array props | **done** — `17b7364`, move drag 121 → 61 rendered frames |
| 1.2 move drag off workspace state | **done** — `1034669`, 61 → 2 React commits |
| 1.2 extrude drag | **not started** — see note below |
| 1.2 cylinder-radius Inspector throttle | **not started** |
| 1.3 rAF-coalesce drag handlers | **done** — `0a0a5d5`, 120 events → 1 apply |
| 1.4 in-place preview geometry | **dropped** — the real-GPU measurement came back; the stall does not exist there (preview drag p95 25 ms). See the box in 1.4 |
| 3.1 motion vocabulary | **done** — `packages/viewport/src/motion.ts` + `--dur-slow` |
| 3.2 edge hover easing | **done** — width and opacity ramp together |
| 3.3 selection symmetry | **done** — fade-out on deselect, x-ray and preview halves rise with their twins |
| 3.5 chip/keypad transitions | **done** — colour and elevation over `--dur-fast`, `transform` excluded |
| 3.2 cursor hysteresis | **done** — the cursor is only written when it changes |
| 3.2 hover dwell | **not started** — a dwell before re-committing preselection is still open; the cursor no longer strobes, the highlight can |
| 3.3 face hover cross-fade | **done** — an outgoing pair carries the leaving face at its current opacity |
| 3.4 gizmo entrance + hover affordance | **done** — shared rig presence controller; offset rig adopts it |
| 3.4 cylinder and edge rigs | **done** — both adopt the shared controller |
| 3.4 gizmo exit | **done** — disarmed rigs fade out and are disposed once gone |
| 3.5 "kernel is behind" affordance | **done** — `LivePreview` announces the degrade once and the chip reads `paused` |
| 4 trackpad two-finger pan + pinch zoom | **done** — `wheelGesture.ts` classifier, `auto`/`mouse`/`trackpad` supported by the controller |
| 4 navigation preference in Settings | **done** — Viewport › Scroll wheel: detect / mouse / trackpad |
| 2.3 window-resize coalescing | **done** — one render per frame instead of one per event |
| 2.1 defer the workspace-session write | **done** — the pivot report is deferred off the press frame |
| 2.2 precompute move snap candidates | **not started** |
| 5.2 cache the canvas rect for picking | **done** — one layout read per event, not per raycast |
| 5.3 callout layout thrash | **done** — all rects read before any margin is written |
| 5.1 BVH / prefilter for picking | **not started** — needs a dependency decision, and the headed numbers do not currently justify it |
| 5.5 DPR listener | **done** — the canvas follows the display it is dragged to |
| 5.6 snap-scan allocation | **done** — one scratch vector instead of one per candidate |
| 5.4 sketch geometry reuse | **not started** — needs a capacity-buffer rewrite of the preview `LineGeometry`; real per-move allocation, no measured symptom |
| Close-out: `docs/interaction-design.md` | **done** |

**2.1, as landed.** The fix is in `CameraController.pivotOn`, not in the
storage hook: the pose report that ran from `pointerdown` now goes through a
deferred emit. It cannot use `scheduleSettledViewChange`, which declines to
fire while a gesture is running — a press-and-hold pivot would then never be
reported at all, which is exactly how the first attempt failed. Releasing
still reports immediately, so a finished gesture never waits on the timer.

The history below is kept because it explains why the obvious version does
not work.

**The earlier attempt, and why it was reverted.** The cost is real and now measured: pressing to
orbit performs **3 synchronous session writes** on the press frame, each a
read-parse-validate-serialise-write of the whole record, because re-pivoting
on the picked point reports a pose from inside `pointerdown`. Deferring that
write is a two-line change and it works — but it moves when the persisted
pose becomes readable, and three existing camera specs read the stored pose
immediately after moving the camera (`viewport.spec.ts` 134, 367, 597). A
250 ms delay broke them; deferring to the next task fixed them but made the
property unobservable from Playwright, since a CDP round trip crosses task
boundaries anyway.

So the deferral needs to be driven by the gesture rather than by a clock:
persist on the settle path the `CameraController` already has
(`scheduleSettledViewChange`), and let the mid-gesture reports update memory
only. That is a change to the controller's contract with its `onViewChange`
sink, not a hook-level tweak, which is why it was not folded in here.

Full E2E suite after 1.3: 127 passed, 8 skipped, 0 failures.

**Note on the extrude drag.** It does not take the same fix as the move drag.
A move drag already updated the scene imperatively through
`applyMovePreview`, so the state write was pure display and could be replaced
by a sink. The extrude ghost is built *from* `extrudePreview.distance` in
workspace state, so removing the per-move write means giving the viewport an
imperative extrude preview first. That belongs with 1.4, not ahead of it.

**Known flake, not a regression.** `visual-selection-live-preview.spec.ts:3`
fails under full-suite load and passes in isolation. Verified against the same
commit with these changes stashed: the suite fails there too (that run also
lost `viewport.spec.ts:367`). Attribute a failure in either only after a
stashed comparison run.

## Ground rules

- One phase = one PR series on its own branch; every PR carries before/after
  probe output in the description. Never push to a branch whose PR merged.
- Probe numbers are SwiftShader CI numbers — regression gates, not UX
  claims. User-felt acceptance for motion work is a short screen recording
  per phase for Peter to judge.
- No public API changes anywhere in this plan. Feature flags are not needed:
  every change is behavior-preserving or pure presentation, except the
  motion work, which respects `reducedMotion`.
- Traps that already burned sessions (keep in view): props passed to
  ModelViewer must be memoized or drag rigs rebuild per render; ModelViewer
  cannot Fast Refresh — hard-reload before trusting interaction behavior;
  `reuseExistingServer` can test a stale build — kill port 4319 first;
  browser-pane rAF never fires — screenshot to force paints.

---

## Phase 0 — Stop the bleeding, see clearly (regression + instrumentation)

### 0.1 Phantom hover-batch fix

`packages/viewport/src/render/edgeOverlay.ts`: at the end of the
`BodyEdgeOverlay` constructor, zero the two hover batches:

```ts
replacePositions(this.hoverEdges, []);
replacePositions(this.hoverHiddenEdges, []);
```

(`replacePositions` already sets `instanceCount = 0` and `visible = false`.)
Leave the `instanceCount > 0` visibility rule in place — it becomes correct
once the count starts at zero. Regression test in `edgeOverlay.test.ts`:
construct an overlay, call `setDisplayMode('shaded-edges')`, assert
`hoverEdges.visible === false` and `geometry.instanceCount === 0`; then
`setHovered(owner)` and assert visible, then `setHovered(null)` and assert
hidden again. Acceptance: interaction probe mean triangles returns to
~2,800 and frame p50 to ~16.7 ms on the same machine that measured 24.9.

### 0.2 Probe coverage for the jank that matters

Extend `test/e2e/interaction-probe.spec.ts` (all `OZ_PERF`-gated, excluded
from the normal suite) with three scenarios:

- **Hover sweep:** no buttons, serpentine sweep across the Heat Sink at
  ~120 moves; report frame p50/p95 and hover input-to-frame latency.
- **Move-gizmo drag:** select a body, drag the gizmo along one axis;
  report frame times *and React commit count* (below).
- **Preview drag:** fillet-radius drag on a Heat Sink edge (the
  preview-publish path); report frame times, preview publish count, and
  max gap between pointermove and next painted frame.

React commit counter: in `OZ_PERF` builds only, a `<Profiler>` wrapper (or
`onRender` hook) around App increments `window.__ozReactCommits`; probes
read it before/after a gesture. This is the acceptance signal for Phase 1
(target: commits during a drag ≈ 0–2, not one per pointermove).

### 0.3 Baseline capture

Three serial runs of the extended probe on the M5, recorded in
`docs/performance-baseline.md` as the 2026-08-12 section. Also capture once
headed on the real GPU for context (documented as non-gating).

Estimated size: small. 2 PRs (fix+test, probe extensions+baseline).

---

## Phase 1 — Drag pipeline: geometry tracks the hand (audit items 1, 2, 3, 5)

The core defect chain: preview publish → new `viewerBodies` identity → full
scene teardown; plus per-pointermove App setState. Four sub-changes, each
its own PR, in this order:

### 1.1 Memoize the unstable ModelViewer props (cheap, immediate)

`App.tsx:10341` (`sketches`), `:10361` (`editableBodyIds`), `:10422`
(`selectedProfileIds`): hoist each into `useMemo` with correct deps; module-
level `EMPTY_ARRAY` constants for the ternary arms. Acceptance: with
React DevTools profiler (manual) or the commit counter, an orbit gesture no
longer re-runs the sketch-overlay / region-state / extrude-preview effects
(add a temporary counter assertion in the probe if cheap).

### 1.2 Route per-move drag values through refs, not App state

Pattern already proven by `cylinderRadiusLabelSetterRef`: React owns
gesture *lifecycle* (start/end/commit), refs own per-move *values*.

- **Move drag:** keep `movePreview`/`moveSnap` state for mount/unmount of
  the move card, but stop calling `setMovePreview`/`setMoveSnap` per move
  (`App.tsx:10376-10381`). Add an imperative setter ref that the move card
  and snap readout subscribe to (the card renders its numeric fields from
  the ref via a small `useSyncExternalStore` or a setter callback it
  registers, like the keypad's anchor sink). The commit path reads the
  latest value from a ref at pointerup — it already receives the final
  value through `applyMovePreview`'s machinery, verify and keep one source.
- **Extrude drag:** same treatment for `updateExtrudeDistance`
  (`App.tsx:3799-3807`); the resolved-preview invalidation
  (`setResolvedExtrudePreview(null)`) moves to drag start, not per move.
- **Cylinder radius:** throttle `setLiveCylinderRadius` in
  `Inspector.tsx:621` to rAF (one state write per frame max) — Inspector is
  big; per-move is unnecessary.

Risk: something renders from `movePreview.translation` per move (the move
card at `App.tsx:10751-10755`). That is exactly what moves to the ref
subscription. Search for *all* readers of `movePreview`/`moveSnap` first
(seven sites, listed in the audit session) and classify each as
lifecycle (React) vs per-move (ref).

Acceptance: probe React commit count during a move drag drops from
~1/pointermove to ≤2 total; move-drag frame p95 improves on SwiftShader;
no behavioral change to snapping, the card values, or commit.

### 1.3 rAF-coalesce the drag branches

In `handlePointerMove` (`ModelViewer.tsx:4346+`), drags currently do full
work per raw event. Introduce the same pending-event pattern hover uses:
stash the latest event per active drag type, drain once per frame in
`animate()` before the render. Keep pointerdown/up synchronous. Use
`event.getCoalescedEvents()` only if sub-frame sampling is ever needed for
precision (not expected — CAD drags are absolute-position, not path-
integrated; the newest event is sufficient).

Ordering note: 1.3 lands after 1.2 so the coalescing isn't masking
per-event React renders during its own verification.

Acceptance: identical drag behavior at normal mouse rates (E2E suite
passes); probe drag scenarios show one drag-work execution per frame
(assert via an OZ_PERF counter on the drag path).

### 1.4 In-place preview geometry for the dragged body

> **Resolved 2026-08-13 by measurement: this item is dropped. Do not
> implement it.** The headed run on the target GPU (Apple M5 Pro, ANGLE
> Metal) puts the preview drag at 8.4 ms p50 / 25.1 ms p95, worst frame
> 33.5 ms — against ~500 ms p95 under SwiftShader. There is no stall to fix.
> The reasoning that got here is kept below because it is the argument for
> why nothing was built.
>
> A first reading of that run also claimed the move drag ran at half rate
> (16.7 ms p50 against orbit's 8.3 ms). That was wrong: the scenario sleeps
> 10 ms between synthetic moves, and removing only the sleep gives 8.3 ms
> p50 — the harness was setting the interval. Every measured gesture meets
> the frame budget on target hardware, so **no frame-pacing work is left to
> justify in phase 1 or 2 on these numbers**, and phase 3 (feedback and
> motion) is where the felt jank now points.
>
> The audit blamed the preview drag's ~500 ms p95 frame on the scene being
> torn down and rebuilt per published preview. That teardown is real, but it
> is not what costs the time. Measured on the Heat Sink offset drag
> (M5, headless SwiftShader), everything on the main thread is small:
>
> | Path | Cost across the whole drag |
> | --- | ---: |
> | Scene rebuild (`oz:viewer.bodies`) | 8 ms total, 2.9 ms max, 4 rebuilds |
> | `LivePreview.build()` (document clone + command) | 8 ms total, 1 ms max |
> | `postMessage` serialization | 3 ms total |
> | `publish()` (setState) | 0 ms |
> | Dimension labels + CSS2D render + callout clamp | 35 ms total across 131 frames |
> | `renderer.render` | 319 ms across 131 frames, 38 ms max |
> | Worker round trip (post → arrival) | 74–211 ms, of which 60–138 ms is kernel compute |
>
> Against that, the drag contains **six long tasks of 500–693 ms**. A move
> drag, which runs no kernel preview, contains **one of 71 ms** — so the
> stalls belong to the preview round trip, but not to any instrumented step
> of it. Shader programs stay at 16, so it is not program churn either.
>
> That signature — main-thread time attributable to no JavaScript — is the
> one `docs/performance-baseline.md` already documents for startup, where a
> CPU profile put ~909 ms in V8's `(program)` bucket (GPU/driver work,
> rasterisation, shader compilation) and where the same cost measured ~900 ms
> headless against ~40 ms headed on a real GPU with a warm cache.
>
> **So the next step for 1.4 is not code, it is a measurement on real
> hardware**: run the preview-drag probe headed on the target GPU and see
> whether the stall exists there at all. If it does not, the audit's item 1
> is a SwiftShader artifact, this phase drops to whatever the real numbers
> justify, and the extrude drag's per-move `setState` (which 1.2 could not
> fix without it) becomes the actual reason to do the work. If it does, take
> a Chrome DevTools CPU+GPU trace of one stalled frame before choosing
> between the designs below — the buffer uploads implied by disposing and
> recreating every body's geometry and fat-line batches per publish are the
> leading remaining suspect, and that would still point at reuse.
>
> None of this changes 1.1–1.3, which were measured end to end and stand.

Design decision, once the measurement above justifies it:

- **Chosen direction (a): per-body reuse by content key.** The worker's
  preview document arrives fully structured-cloned, so object identity is
  useless. Add a cheap per-body `meshRevision` to `BodyRepresentation`
  computed in the worker (hash of buffer byte lengths + feature version +
  ADR-011 face-hash multiset is enough discrimination; do NOT hash full
  buffers). In the body-rebuild effect, replace the all-or-nothing
  `bodiesChanged` with per-body comparison: reuse `objectsByBodyId` entries
  whose `meshRevision` matches, rebuild only changed bodies. Hover/selection
  reset also becomes per-body (`resetForRebuild` gains a scoped variant).
- **Fallback (b)** if `meshRevision` proves awkward: `LivePreview` consumers
  know the edited body; thread `changedBodyIds` through `publish()` and
  rebuild only those. Less general (booleans can touch other bodies —
  fail open to full rebuild when the hint is absent).

Additional required piece either way: **stop refreshing the shadow map on
preview landings for small edits** is *wrong* — the body's silhouette
changes, so keep the refresh, but it becomes cheap once only one body's
geometry changed (shadow render cost is per-scene; measure before deciding
to keep per-publish refresh vs. refresh-on-commit only).

Schema note: `BodyRepresentation` gains an optional derived field — check
`packages/shared` versioning; derived-only fields need no migration, but
verify `normalizeDocument` tolerance and that the field never enters
canonical content (see the canonical-divergence rule: derived only).

Acceptance:
- Probe preview-drag scenario: no `clearGroup(bodyGroup)` during the drag
  (OZ_PERF counter), hover state survives preview landings, frame p95
  during fillet drag materially better than baseline.
- All existing suites green (`pnpm test:coverage`, `test:web`, `test:e2e`,
  `test:parity-corpus` untouched but run once — kernel adapter changed).
- Manual: fillet drag on Heat Sink — geometry updates without the whole
  model blinking; selection highlight stays put.

Estimated size: 1.1 small; 1.2 medium; 1.3 medium; 1.4 large (the
discovery decides a/b; budget the largest single chunk of the program).

---

## Phase 2 — Gesture-start latency (audit item 4 + pointerdown work)

- **2.1 Defer the workspace-session write.** `emitViewChange` currently
  reaches synchronous localStorage inside the orbit pointerdown
  (`CameraController.ts:555` → `workspaceSession.ts:213-229`). Wrap the
  sink `App.tsx:3662` passes to `useProjectView` in a microtask-safe
  debounce (e.g. `requestIdleCallback` with 250 ms timeout, trailing
  write-through on `visibilitychange`/`pagehide` so a tab close still
  persists). The CameraController contract ("durable pose sink, already
  debounced") stays; only the App-side sink changes.
- **2.2 Move snap-candidate collection off pointerdown.**
  `collectMoveSnaps()` + `collectCenterAlignTargets()` run synchronously in
  `handlePointerDown` (`ModelViewer.tsx:4737-4738`) and are O(all edges +
  all face centers). Precompute when the move tool arms / selection
  changes (idle-scheduled), invalidate on document change, keep a
  synchronous fallback for the cold case. Same data, same results —
  regression-test snap behavior via the existing move E2E specs.
- **2.3 Window-resize hygiene:** rAF-throttle `setWindowWidth`
  (`App.tsx:922-927`).

Acceptance: no localStorage access inside any pointerdown (assert with an
OZ_PERF instrumentation hook that wraps `Storage.prototype.setItem` in the
probe and fails on gesture-window writes); move-drag start on the demo has
no measurable pre-drag stall.

Estimated size: small-medium. 2 PRs.

---

## Phase 3 — Feedback continuity: a motion system, then apply it
(audit items 6, 7, 8, 9, 11)

### 3.1 One motion vocabulary

New tiny module `packages/viewport/src/motion.ts` (TS side) + extend
`tokens.css` (CSS side), same values both sides:

- Durations: `fast = 100 ms`, `base = 200 ms`, `slow = 350 ms` (new token
  `--dur-slow`).
- Easing: the existing `--ease-out` cubic-bezier(0.16,1,0.3,1) everywhere;
  TS equivalent exported as a function; `linear` reserved for spinners.
- Opacity/width easing helper for three.js: the existing exponential
  `1 - exp(-dt/τ)` with τ = 60 ms, extracted from its two duplicated sites
  (`SelectionManager.ts:429`, `ModelViewer.tsx:5739`) into one exported
  `easeToward(current, target, dtMs)`; `FADE_EPSILON` moves with it.
- `reducedMotion()` plumbed into `SelectionManager` (the camera already
  has it) — reduced motion = snap to target, exactly like the camera path.

Normalize the CSS strays that are user-visible (tool card 140 ms → tokens;
bare `ease` in the orientation widget → `--ease-out`; leave spinner periods
alone but pick one: 900 ms).

### 3.2 Edge highlight easing (audit item 6)

Fat-line width/color cannot cross-fade by material swap without cost; use
the fade infrastructure: give `hoverEdges` / `selectedEdges` materials an
eased opacity ramp (0 → target over ~100 ms) driven from the existing
settle loop, and ease width via `material.linewidth` toward target with the
same helper (LineMaterial linewidth is a uniform — cheap per frame).
Cursor: add ~60 ms hysteresis before *clearing* hover (entering a new
target switches immediately; leaving to empty space waits) — kills the
strobe across dense topology and the cursor flicker together
(`SelectionManager.ts:399-406`).

### 3.3 Selection symmetry (audit item 6)

- Fade out on deselect: instead of `clearGroup(selectionGroup)` at
  `ModelViewer.tsx:6180-6185`, set `targetOpacity = 0` and dispose on
  settle (the fade loop already exists; add a `disposeOnZero` flag to the
  fadeIns entries).
- X-ray half fades with its visible twin (`:6265-6274` joins `fadeIns`).
- Preview highlights (`:6448-6456`) go through the same path.
- Face hover cross-fade: keep the old film at its current opacity fading
  out while the new face's film fades in — two mesh slots instead of one in
  `SelectionManager` (`setHoverFace` currently teleports geometry, `:225-269`).

### 3.4 Gizmo entrance/exit + hover (audit item 7)

In `rigs.ts`: each rig group gets `enter()` (scale 0.85→1 + opacity 0→1
over `fast`, played on install) and `exit(onDone)` (reverse, then dispose).
Arm/disarm call sites in `ModelViewer.tsx:6701-6845` switch from
add/dispose to enter/exit. Add `setHot(boolean)` on rigs — pointer-over
(reuse the existing gizmo raycast in `applyHoverAt`) brightens the arrow
~15% and swells width by 1 px, eased. Move-gizmo focus dim
(`move.ts:170-172`) goes through `easeToward` instead of instant.

### 3.5 "Kernel is behind" affordance (audit item 8)

- While a preview build is in flight past one frame (~50 ms), drop the
  dragged body's ghost/preview material opacity slightly or pulse the
  value chip's border with `--dur-base` — subtle, no spinner.
- When `LivePreview` degrades (`slow = true`, `livePreview.ts:113-118`):
  the value chip gets `data-state="deferred"` styling ("will apply on
  release" title), so the frozen geometry is explained. Also revisit the
  default: with Phase 1.4 landed, rebuilds are cheaper — try
  `continueAfterSlow: true` for offset/fillet with the 150 ms viewport
  throttle as the only gate, measure, then decide.
- Chips/keypad/HUD entrances: `oz-fade` (opacity-only, FB-04-safe) on
  `.handle-value-chip`, `.handle-label-chip`, `.numeric-keypad`; HUD
  show/hide gets an opacity transition instead of `hidden` where the
  element persists (`HudLayer.ts` gains show/hide methods that toggle a
  class; keep `hidden` for teardown).
- Warning state transitions color via the tokens (`rigs.ts:198-208` eased;
  chip CSS gets `transition` on border/background).

Acceptance for Phase 3: recording for Peter (hover sweep, select/deselect,
gizmo arm/disarm, fillet drag with deliberate slow preview) + reduced-motion
spot check + probe unchanged-or-better frame numbers (motion must not add
per-frame cost when idle: all eased values settle and stop requesting
frames — verify via the existing `isSettling` pattern).

Estimated size: medium, but wide. 4–5 PRs (motion module, edges+cursor,
selection, gizmos, chips/degrade).

---

## Phase 4 — Trackpad and input tuning (audit item 10)

- Detect trackpad-style wheel events (deltaMode 0 with small fractional
  deltas and both axes) — pragmatic heuristic, documented as such.
- Two-finger scroll = pan; pinch (`ctrlKey` wheel) = zoom-to-cursor;
  Shift+two-finger = orbit (matching the existing Shift+left orbit).
  A navigation preference ("Trackpad mode: auto / mouse / trackpad") in
  Settings, default auto — preferences already flow through
  `refreshNavigationPreferences`.
- Pen/touch: verify OrbitControls' touch defaults on the iPad-in-Safari
  case once, log findings, but active tuning is out of scope until there's
  a target device.

Risk: wheel heuristics misfiring on exotic mice — the preference is the
escape hatch. Acceptance: manual on MacBook trackpad + external mouse;
E2E wheel tests still green.

Estimated size: medium. 1–2 PRs.

---

## Phase 5 — Picking and per-frame cost cleanup (audit tier 3)

In descending value:

1. **BVH for body raycasts** (`three-mesh-bvh`, well-maintained, ~40 kB):
   build lazily per body mesh on install, dispose with it. This is a new
   dependency — flagged now, needs Peter's OK. Fallback: screen-space AABB
   prefilter before `intersectObjects`, no dependency.
2. Cache the canvas rect: `setRayFromEvent`'s per-call
   `getBoundingClientRect` (`PickService.ts:104`) → cached, invalidated by
   the existing ResizeObserver and scroll.
3. `clampNameCallouts` batches reads then writes (`ModelViewer.tsx:623-658`);
   `updateOffsetChip` caches the inspector rect per drag, not per frame
   (`:3628-3632`); HudLayer moves to `transform` positioning and caches its
   rect per frame (`HudLayer.ts:45-107`).
4. Sketch `LineGeometry` reuse: preallocate with capacity and update
   attributes in place (`sketchModeController.ts:398-454`), same pattern as
   `replacePositions`.
5. DPR: `matchMedia('(resolution)')` listener → `setPixelRatio` + resize
   (`ModelViewer.tsx:1057`).
6. Snap-scan allocation: `SnapEngine` projector takes a scratch `Vector3`
   (`SnapEngine.ts:98-115`); measure-mode `pickAll` drops the
   `JSON.stringify` dedup key for a cheap composite string
   (`PickService.ts:47-56`).

Acceptance: probe hover-sweep p95 improvement; no behavior change
(pick results identical on the E2E suites, which exercise pick paths
heavily).

Estimated size: medium. 2–3 PRs. Item 1 blocked on dependency approval.

---

## Sequencing and the feedback loop

```
Phase 0 ──► Phase 1.1 ─► 1.2 ─► 1.3 ─► 1.4 ──► Phase 3 (needs 1.4's cheap rebuilds)
                │                        
                └──► Phase 2 (independent after 0)   Phase 4, 5: independent, anytime
```

- Phases 0–2 are objective (probe-gated) and safe to run autonomously,
  PR by PR.
- Phase 3 needs Peter in the loop: after 3.1+3.2 land, a recording decides
  whether the values (100/200/350 ms, τ=60 ms) feel right before they're
  applied everywhere. Peter's own recordings of worst moments (standing
  request) can reorder 3.2–3.5 at any time.
- Re-baseline `docs/performance-baseline.md` after Phase 1 and Phase 5.
- Close-out: distill final constants into a short
  `docs/interaction-design.md` (easing/duration/latency budgets, camera
  constants, the ref-vs-state rule for gestures) so future features
  inherit the feel.

## Out of scope (explicitly)

- Camera dynamics — already well designed; only touched by Phase 2.1's
  storage deferral.
- New gestures/tools, marking-menu changes, sketch-mode UX beyond the
  geometry-churn fix.
- 120 Hz-specific pacing work: on-demand rendering already renders at
  display rate when active; nothing here caps it. Verify on ProMotion once
  Phase 1 lands, treat separately if an issue survives.
