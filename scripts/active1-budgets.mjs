// ROADMAP Active 1 budgets (H02, W01), proposed from the baselines in
// docs/performance/2026-11-15-active1-baselines.md: medians of three
// quiet-host runs on a Ryzen 5 5600 with a Radeon RX 6600 (Vulkan ANGLE),
// in milliseconds. A budget is a regression ceiling for that machine, not a
// product target; W01's 100 ms screen target is stated separately and the
// 100-feature edit does not meet it yet. `scripts/measure-active1-baselines.mjs
// --check` fails a run whose median exceeds a budget, and
// `PATTERN_PERF_BUDGET=1` makes the Node pattern probe assert its own.
export const ACTIVE1_BUDGETS = Object.freeze({
  /** Per H02 fixture, matched against the probe's scenario title. */
  firstEditAfterReload: Object.freeze([
    Object.freeze({
      match: 'synthetic holder',
      reloadToReadyMs: 1_000,
      settledFirstEditMs: 850,
      immediateEditMs: 1_300
    }),
    Object.freeze({
      match: 'lettered holder',
      reloadToReadyMs: 700,
      settledFirstEditMs: 400,
      immediateEditMs: 900
    })
  ]),
  /** W01: Apply → the revision-matched viewport frame. */
  interaction: Object.freeze({
    'w01-box': Object.freeze({ medianMs: 60, p95Ms: 100 }),
    'w01-history': Object.freeze({ medianMs: 150, p95Ms: 170 })
  }),
  /** The W01 screen-feedback target the interaction budgets are judged by. */
  interactionTargetMs: 100,
  /**
   * H02 face drags (`face-drag` probe), per `perf-face-drag-trace` case
   * label. The pointer is followed by disposable proxy frames; the exact
   * preview is built once the hand rests. Regression ceilings from two runs
   * on the RX 6600 (Vulkan) in
   * docs/performance/2026-11-20-drag-orbit-sustained-baselines.md: medians
   * proxy lag 14–15 / 15–16 ms (p50 / p95), frame interval 16.7 ms (p95
   * 33 ms on the filleted unions, one hitch each), exact preview round trip
   * 63–404 ms, release → accepted 74–170 ms.
   */
  faceDrag: Object.freeze({
    'filleted union width 30 to 22.5 mm': Object.freeze({
      lagP50Ms: 25,
      lagP95Ms: 30,
      exactPreviewMs: 600,
      frameIntervalP50Ms: 20,
      frameIntervalP95Ms: 50,
      releaseToFrameMs: 160
    }),
    'public filleted union history': Object.freeze({
      lagP50Ms: 25,
      lagP95Ms: 30,
      exactPreviewMs: 280,
      frameIntervalP50Ms: 20,
      frameIntervalP95Ms: 50,
      releaseToFrameMs: 250
    }),
    'rounded box top face (primitive proxy)': Object.freeze({
      lagP50Ms: 25,
      lagP95Ms: 30,
      frameIntervalP50Ms: 20,
      frameIntervalP95Ms: 25,
      releaseToFrameMs: 260
    }),
    'native holder +Z face (plate, cut, two arms)': Object.freeze({
      lagP50Ms: 25,
      lagP95Ms: 30,
      exactPreviewMs: 120,
      frameIntervalP50Ms: 20,
      frameIntervalP95Ms: 25,
      releaseToFrameMs: 130
    })
  }),
  /** H02's stated drag targets: 60 fps, first geometry ≤ 100 ms, p95 ≤ 50 ms. */
  faceDragTargets: Object.freeze({
    frameIntervalMs: 1000 / 60,
    firstGeometryMs: 100,
    lagP95Ms: 50
  }),
  /**
   * H02 orbit tails (`orbit` probe), per `<scene> x<cpu slow-down>`, or
   * `* x<rate>` for every scene: the viewer's own frame interval p95/p99
   * (`oz:viewer.frame`) and its frames per second, a floor. Every scene
   * measured 58.5–60 fps with no viewer frame over 16.8 ms at both rates on
   * the RX 6600.
   */
  orbit: Object.freeze({
    '* x1': Object.freeze({ p95Ms: 20, p99Ms: 25, minViewerFps: 55 }),
    '* x4': Object.freeze({ p95Ms: 25, p99Ms: 34, minViewerFps: 50 })
  }),
  /**
   * H02 sustained-session retention (`sustained` probe, 300 edits of the
   * public filleted union with idle compaction). From
   * docs/performance/2026-11-20-sustained-session.md: peak WASM memory
   * 102 MB (97 MiB), peak retired slots 66,194, heap and edit time flat.
   */
  sustained: Object.freeze({
    peakLinearMemoryMiB: 128,
    peakRetiredSlots: 2 * 65_536,
    heapGrowthMiB: 4,
    editDriftRatio: 1.15
  }),
  /** The M02 gate: a 10 × 10 grid of the ×50 bar, input → accepted frame. */
  patternPreview10x10: Object.freeze({
    nodeMedianMs: 10_000,
    browserMedianMs: 10_000
  })
});
