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
  /** The M02 gate: a 10 × 10 grid of the ×50 bar, input → accepted frame. */
  patternPreview10x10: Object.freeze({
    nodeMedianMs: 10_000,
    browserMedianMs: 10_000
  })
});
