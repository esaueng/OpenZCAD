# Face-resize commit hitches

A screen recording of a face resize on Box ∪ Cylinder with a five-edge R2
junction fillet (60–210k triangles) showed several frames over 25 ms per drag
and commit, worst frames of 177–231 ms and p99 of 55–64 ms. The opt-in probe
`test/e2e/perf-face-drag-trace.spec.ts` now has a case with that shape:
`traces two committed face resizes through save` builds the union with
`filletedUnion(adapter, { width: 32.5, radius: 2, heightEdit: false })`, drags
the right face 32.5 → 23 mm, commits, then drags it 23 → 31 mm and commits.
Each drag is traced through the commit's save state and one quiet second.
This is a public surrogate of the recording, not the recorded document.

## Root causes

CPU profiles and Chrome timelines (with invalidation tracking) of the probe
identified these main-thread costs.

1. **Workspace restyle on every chip update (largest).** While dragging, the
   value chip, its "Total ▾ / Offset ▾" tag and the drag HUDs rewrote their
   text through `textContent` or `replaceChildren` every frame, including
   when the text did not change. The stylesheets carry about 140 `:has()`
   rules anchored on `.viewer-area` and `.workspace`. A child-list mutation
   under them makes Chromium re-evaluate those rules and restyle the
   workspace subtree. Measured in the browser in the middle of a drag, one
   chip text replacement cost **11.2 ms** of forced style recalculation. The
   cost was 0.2 ms with the `:has()` rules disabled, and **0.1 ms** when the
   existing text node's data changed instead. One selector,
   `.command-bar-lane.has-guidance:has(.workspace-hint.is-selection) …
.command-bar-input::placeholder`, accounted for about 9 ms of the cost on
   its own. On the timeline, each drag frame carried a 15–25 ms `Layout`
   with only about 13 dirty objects.
2. **History timeline placement on commit.** `HistoryTimeline` placed its
   line in a layout effect, interleaving `offsetTop` reads with
   custom-property writes on the list. Each write restyled the rows, so the
   next read forced another style and layout pass. On a commit, which adds
   a feature row, that cost 40–50 ms inside React's commit.
3. **Live section cap on outward drags.** The veil's `liveCap` re-sections
   the deformed live mesh whenever its positions change, which is every
   frame. `sectionCapGeometry` allocated arrays and closures for each
   triangle and read through attribute accessors: 20–35 ms per frame on
   this model. The veil's `reachesBeyond` scan made a similar full pass.

The save path (`Saved → Syncing → Saving → Saved`) did not appear among the
long tasks. The IndexedDB write's structured clone stayed below the 50 ms
long-task threshold in every trace.

## Changes

- `apps/web/src/lib/domText.ts`: `setElementText` updates a lone text node's
  data in place and keeps `textContent = ''` semantics. `renderChipText`
  reuses the prefix, number and units spans while their split is unchanged.
  ModelViewer uses them for the per-frame offset, radius and edge chips, the
  tag chip, the drag, move and measure HUDs, snap glyphs and sketch
  dimension labels. A cylinder's value updates its text and units nodes in
  place.
- The placeholder rule reads a `has-selection-hint` class on the command-bar
  lane. `WorkspaceReadout` sets the class under exactly the conditions that
  render `.workspace-hint.is-selection`.
- `placeTimeline` measures every row before writing anything and skips
  values that are unchanged. It runs from the ResizeObserver's first report,
  which a browser delivers after that frame's layout and before paint.
  Without ResizeObserver it still places synchronously.
- `sectionCapGeometry` and `reachesBeyond` read plain non-normalized buffers
  directly with the same arithmetic. Other layouts keep the attribute path.
  A unit test checks that indexed, interleaved and non-indexed buffers give
  identical caps.

## Measurements

The host was a Windows 11 laptop with Intel UHD Graphics, Chromium headless
through ANGLE D3D11, at 1440 × 1000 and DPR 1. Other agent sessions held the
CPU at **100 %** throughout (sampled with the `% Processor Time` counter).
Wall-clock frame intervals therefore vary several-fold from run to run.
The comparison below uses Chrome timeline totals of main-thread work. These
are much less sensitive to contention than frame intervals. Before and after
builds are minified production builds (`VITE_E2E=1 OZ_PERF=1`) of `main`
`f8dafb21` and this branch, run interleaved. Two rounds are shown, both
drags each; times are milliseconds.

| Run              | Drag layout | Drag busy | Drag tasks > 50 | Post-release layout | Post-release busy | Post-release tasks > 50 | Post-release max task |
| ---------------- | ----------: | --------: | --------------: | ------------------: | ----------------: | ----------------------: | --------------------: |
| before r1 inward |        1605 |      3624 |               0 |                 239 |               713 |                       2 |                    63 |
| before r1 out    |        2150 |      6494 |              24 |                 504 |              1235 |                       4 |                   113 |
| before r2 inward |        3030 |      7075 |              26 |                 334 |               916 |                       3 |                    56 |
| before r2 out    |        3532 |     10826 |              96 |                 496 |              1221 |                       5 |                   100 |
| after r1 inward  |         183 |      2763 |               1 |                  52 |               730 |                       2 |                    67 |
| after r1 out     |         155 |      2996 |               4 |                 112 |               969 |                       3 |                   114 |
| after r2 inward  |         189 |      2352 |               1 |                  50 |               507 |                       1 |                    60 |
| after r2 out     |         104 |      1953 |               0 |                  35 |               396 |                       0 |                    44 |

"Busy" sums the main thread's top-level tasks. "Post-release" starts at
pointer-up and runs through the save and the quiet second. An earlier
unminified, profiled pair on the same host showed the same pattern. Per-drag
layout fell from 4,353 ms over 268 layouts to 400 ms over 173 layouts, and
the outward drag's long tasks fell from 85 to 1.

**The goal of no frame over 50 ms per commit is met in one of four post-release
windows, not in all of them.** The remaining post-release tasks of 44–114 ms are
frame-lifecycle style and layout after the commit's React update. The largest
is the "More tools" flyout. The probe's stubbed device opens it, and it
unmounts while the in-place command suspends the fold. It remounts about 500
nodes after the commit. Other contributors are `placeSelectionCallouts`, the
first `getBoundingClientRect` of that frame, which pays for the layout, and
the workspace restyle that any remaining child-list mutation still triggers
through the other `:has()` rules (about 5 ms per mutation). These are in the
command rail and selection-callout code, which other work is changing at the
same time, so this PR leaves them unchanged. Also unchanged:
`reuseRenderBodies`' typed-array equality (about 10 ms per reply on this
model), the first-drag shader `getProgramParameter` stall and the drag-start
`beginOffsetDrag` setup (35–60 ms).

These are local measurements on a contended host, not a deployed-device
frame-rate guarantee.

## Reproduction

```bash
VITE_E2E=1 OZ_PERF=1 pnpm --filter @openzcad/web build
pnpm --filter @openzcad/web preview --host 127.0.0.1 --port 24695
OZ_PERF=1 OZ_FACE_DRAG_ANGLE=d3d11 PLAYWRIGHT_PORT=24695 \
  OZ_FACE_DRAG_TIMELINE=/tmp/face-commit-traces \
  pnpm exec playwright test perf-face-drag-trace \
  --grep "two committed" --workers=1 --retries=0
```

`OZ_FACE_DRAG_COMMIT_BUDGET_MS=<ms>` makes the case fail when any main-thread
task from release through the save exceeds the budget. The tasks come from a
Chrome trace (`RunTask` on the renderer main thread), not the Long Tasks API,
which omits every task of 50 ms and under; any positive budget is therefore
checked honestly. Each commit must also reach a successful save of its
revision: a failed device write fails the case. It is a local regression check
only. Timing depends on the host, so CI never sets it.
