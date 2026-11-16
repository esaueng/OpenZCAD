# Active 1 edit-speed baselines (2026-11-15)

The measurement half of [ROADMAP](../../ROADMAP.md) Active 1, rows
[H02](../../ROADMAP.md#h02) and [W01](../../ROADMAP.md#w01): three
reproducible baselines, each with a proposed budget. No optimisation was
made here. [Biggest contributors](#biggest-contributors) lists the work for
later lanes, and the
[provenance](2026-11-15-active1-baselines.provenance.json) keeps every run's
host snapshot and summary row.

| Measurement                                            | Baseline (median of 3 runs) | Budget (median) |
| ------------------------------------------------------ | --------------------------: | --------------: |
| H02 first edit after a settled reload, drilled holder  |                      556 ms |          850 ms |
| H02 first edit after a settled reload, lettered holder |                      260 ms |          400 ms |
| W01 Apply → frame, simple box (median / p95)           |                  38 / 42 ms |     60 / 100 ms |
| W01 Apply → frame, 100-feature history (median / p95)  |                121 / 132 ms |    150 / 170 ms |
| 10 × 10 grid pattern preview, browser                  |                    7,524 ms |   **10,000 ms** |

**M02 gate.** The feature-patterns lane (M02) may not land a change that
takes the 10 × 10 pattern preview's browser median above **10 s** on this
machine (`pattern-browser`, 10 × 10 row), or the Node adapter's above 10 s
(`pattern-node`). Today it is 7.5 s. Done after the preview must keep
committing that frame without a replay (`replayed: 0`, asserted by the Node
probe).

**W01 target.** The 100 ms screen-feedback target holds for a simple edit
(38 ms) and is **not met** by an edit in a 100-feature history (121 ms
median, every one of 90 samples over 100 ms). The 150 ms budget for that case
is a regression ceiling, not the target.

## Machine and build

| Item     | Value                                                                                                                                                                                                                                                    |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Machine  | AMD Ryzen 5 5600 (6 cores, 12 threads), 15 GiB RAM, Linux 7.0.0-43 x86_64                                                                                                                                                                                |
| GPU      | AMD Radeon RX 6600 (Navi 23), **discrete**. The machine has no integrated GPU (the Ryzen 5 5600 has none), so the Active 1 "integrated-GPU hardware" wording maps here to this machine's discrete GPU. A real integrated-GPU device is still unmeasured. |
| Renderer | `ANGLE (AMD, Vulkan 1.4.335 (AMD Radeon RX 6600 (RADV NAVI23) (0x000073FF)), radv)`, recorded by every browser sample: headless Chromium with `--use-angle=vulkan` (`OZ_PERF_ANGLE=vulkan`)                                                              |
| Browser  | Playwright Chromium 156.0.8078.4, fresh context per run                                                                                                                                                                                                  |
| Node     | 24.22.2                                                                                                                                                                                                                                                  |
| Source   | OpenZCAD `main` at `90c163c62`; this change adds probes, scripts and docs only. Remus 2026.1.141 (`3c489d7`), `remus-wasm` SHA-256 `e6df603b…`, 13,729,389 bytes                                                                                         |
| Build    | `VITE_E2E=1 VITE_E2E_FULL_RENDER=1 pnpm --filter @openzcad/web build` (the production renderer), served by `vite preview`                                                                                                                                |

**Quiet host.** Every run started only when the 1-minute load average was
below 2.0, at least 3 GiB of memory was available and no cargo, rustc or
Playwright process outside the run existed. Other agent sessions share this
machine, and before the measured runs an orphaned headless Chromium left by
another session had to be stopped. Across the 15 runs the load at start was
0.26–1.70, available memory 9.2–9.6 GiB (all of it free), and no busy process
was present. Each sample also records its renderer and a host snapshot
before and after (`host` in the JSONL, `runs` in the provenance).

## Reproduce

```bash
pnpm install --frozen-lockfile
node scripts/measure-active1-baselines.mjs --runs 3 --angle vulkan --check
```

The script waits for a quiet host before every run, builds the production
renderer once, serves it, runs each probe `--runs` times in turn, and
writes `runs.jsonl`, the probes' raw output and `summary.{json,md}` to
`perf-results/active1/<timestamp>/` (git-ignored). `--check` exits non-zero
when a median exceeds its budget in `scripts/active1-budgets.mjs`, and also
turns on the H02 probe's within-run ratio checks and the Node pattern
probe's own assertion. `--summarize <dir>` re-reads a finished run.
`--only` selects probes:

| Probe             | Spec                                                                             | Measures                                                                                                         |
| ----------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `h02`             | `test/e2e/perf-holder-reload.spec.ts`                                            | Reload and the first, second and immediate edits on the drilled (15 features) and lettered (31 features) holders |
| `w01-box`         | `test/e2e/perf-cad-edit.spec.ts`                                                 | 30 width edits of a simple box                                                                                   |
| `w01-history`     | `test/e2e/perf-cad-edit.spec.ts` (`CAD_PERF_BROWSER_HISTORY=100`, isolated part) | 30 width edits in a 100-feature history                                                                          |
| `pattern-node`    | `test/perf/pattern-preview.bench.ts`                                             | Adapter frame sync of 3 × 3, 3 × 10 and 10 × 10 grids, the commit after it, and per-method kernel time           |
| `pattern-browser` | `test/e2e/perf-pattern-preview.spec.ts`                                          | The Grid pattern card: pick the bar (3 × 3), then count 10 (10 × 3), then count 2 10 (10 × 10)                   |

None of them runs in CI. Timings depend on the machine, its load and its GPU,
and the runs take about 20 minutes. `pnpm typecheck` and `pnpm lint` cover
the probes' code. `--angle swiftshader` reruns the browser probes on the
software renderer, which this record did not measure.

`perf-cad-edit` needed one fix to run on current `main`. A validated edit
now adopts its own validation sync as the live result, so no broadcast sync
follows it, and the probe waited 60 s for one and failed. The probe now
takes the adopted sync when no broadcast follows within 2 s, and matches the
viewport marks to the revision the app published for it. Each sample records
which one it used (`syncKind`); every sample here was `adopted-validation`.

## The pattern fixture

QA's 2026-11-14 project (finding #16: "the 10 × 10 grid on a ×50 bar took
72.6 s to preview") is not redistributable. `test/support/large-pattern-bar.ts`
rebuilds its shape from what QA reported: a 30 × 18 × 5 mm block repeated
×50 at the linear pattern's default 20 mm spacing, whose overlapping copies
fuse into one 1010 × 18 × 5 mm bar (QA's readout). The grid uses the card's
defaults, 20 mm along X then 20 mm along Y. The X copies overlap the bar by
990 mm and the Y copies stand 2 mm apart.

This reconstruction previews about ten times faster than QA's figures
(10 × 10: 7.5 s against 72.6 s; 3 × 3: 0.66 s against 3.2 s). Three things
differ, and this record cannot separate them: QA's bar may have kept
different topology, QA ran Remus 2026.1.136 on production, and QA's grid
axes are not recorded. The budget applies to this fixture,
which anyone can rerun.

## Results

Medians of three runs, with the range across runs. Spread between runs is
under 5% everywhere.

### H02: first edit after reload

Enter → exact ready on the `perf-holder-reload` holders. A reload now
restores the persisted history session instead of replaying it.

| Scenario                              | Drilled holder (15 features) | Lettered holder (31 features) |
| ------------------------------------- | ---------------------------: | ----------------------------: |
| Reload → exact ready                  |                648 (647–670) |                 461 (441–492) |
| Warm edit before reload               |                435 (434–453) |                 146 (145–156) |
| **First edit after a settled reload** |            **556 (538–568)** |             **260 (237–278)** |
| Second edit after reload              |                479 (469–488) |                 154 (142–159) |
| Edit typed during the reload          |                854 (852–856) |                 577 (550–593) |

The 2026-09-17 records on these fixtures, on an Apple M5 Pro, were a
2.2–2.4 s reload and a 0.33–1.2 s first edit. Every run also passes that
record's within-run budget (first edit ≤ 1.5 × the warm edit + 250 ms).

The 18–31 s report came from a private hammer holder. Its closest public
relative, the hammer-holder STEP fixture in the Remus repository
(`crates/io/tests/data`), could not be measured. On this pin its verified
"Parameterize holder and text" recipe fails exact-geometry preflight ("This
verified recipe did not pass exact geometry preflight. Nothing was changed."),
so the probe has no parameter to edit. That is a correctness finding for the
kernel lanes, not a timing.

### W01: Apply → frame

Thirty edits per run, from the Apply click to the first viewport frame
carrying that revision (`oz:edit.frame`).

| Stage, median of run medians (ms)           |           Simple box |     100-feature history |
| ------------------------------------------- | -------------------: | ----------------------: |
| Input → worker request                      |                  0.4 |                     1.4 |
| Request → worker response                   |                 16.6 |                    46.5 |
| Response → bodies installed                 |                  9.2 |                    29.7 |
| (of which installation)                     |                  9.5 |                    31.9 |
| Installed → next frame                      |                 11.4 |                    43.0 |
| **Input → frame, median**                   | **37.6 (37.5–37.9)** | **121.1 (120.9–123.0)** |
| **Input → frame, p95**                      | **41.7 (40.6–42.3)** | **131.5 (131.3–134.1)** |
| Samples over 100 ms                         |              0 of 90 |                90 of 90 |
| Long tasks per whole run, incl. setup (max) |        3 (96–101 ms) |      92–93 (288–326 ms) |

The 2026-10-08 SwiftShader figures for the same cases were 168 and 594 ms
median.

### Pattern preview

Input → the Grid pattern card's Done enabled again (browser), and the
adapter's in-place frame sync (Node). Each grid is a fresh build of the bar.

| Grid                             |                 Browser |            Node adapter | Node kernel time | Result faces |
| -------------------------------- | ----------------------: | ----------------------: | ---------------: | -----------: |
| 3 × 3                            |           655 (655–656) |           598 (595–611) |              548 |           66 |
| 10 × 3 (browser) / 3 × 10 (Node) |     2,266 (2,260–2,274) |     1,737 (1,734–1,758) |            1,612 |          220 |
| **10 × 10**                      | **7,524 (7,509–7,530)** | **7,612 (7,602–7,634)** |            7,458 |          780 |

Building the bar itself takes 1.47 s in the browser, from open to drawn.
After the preview, Done's live sync restores the frame in 8–33 ms
(`prefix-restore`, `replayed: 0`).

## Biggest contributors

For later lanes; none was changed here.

1. **Pattern preview: one `fuseAll` call.** In the 10 × 10 frame it takes
   6.79 s of the 7.46 s of kernel time (91%). The rest is `volume` (363 ms
   over 552 calls) and display tessellation (90 ms). The pattern feature is
   97% of the browser frame (7.30 s of 7.52 s), and grows with the copy count
   (0.49 s at 9 copies, 2.18 s at 30, 7.30 s at 100). The overlapping
   X copies make this a fusion of coincident faces. A cheaper fuse, or a
   pattern that unions copies incrementally or skips coincident ones,
   belongs in Remus (K07 / M02). A frame also cannot be cancelled inside
   the feature (QA #16 follow-up).
2. **W01, 100-feature edit: main-thread presentation, not the kernel.**
   The worker answers in 46 ms (the request round trip includes message
   delay). Then about 73 ms goes to the main thread: 30 ms from the
   response to installed bodies (installation itself measures 32 ms) and
   43 ms more to the next frame. The run also logs about 92 long tasks of
   up to 0.3 s, though that count includes the 100-feature setup. Reaching
   100 ms needs about 21 ms off that path: body installation and the frame
   after it with 100 bodies in the scene, even though 99 are hidden.
3. **H02, lettered holder: the restored session's first edit replays.**
   After a session restore, the first edit's preflight replays 27 of 31
   features and restores 4. A warm edit replays 12 and reuses 16
   independent results. That is 138 ms of history against 60 ms. The
   restored session lacks the warm session's reuse state until one edit has
   run, and the second edit is warm again. The idle warm-up rebuilds
   checkpoints in a second kernel, but not this reuse.
4. **H02, drilled holder: every edit replays the whole history.** The
   parameter's first consumer is near the start, so warm and first edits
   alike rebuild 15 of 15 features. The reload adds only about 120 ms of
   cold-kernel cost to the first edit (history 180 ms against 135 ms).
5. **An edit typed during the reload** waits for the reload to finish, then
   pays a full edit: 854 ms, about the reload plus one edit. That is the
   documented queueing behaviour.

## Budgets

Each budget is a regression ceiling for this machine and renderer, set at
about 1.3–1.6 times the baseline median so that load noise on a quiet run
(under 5% here) never trips it. `scripts/active1-budgets.mjs` holds them, and
`measure-active1-baselines.mjs --check` enforces them.

| Measurement                                               |      Baseline |                           Budget |
| --------------------------------------------------------- | ------------: | -------------------------------: |
| H02 reload → exact ready, drilled / lettered              |     648 / 461 |                      1,000 / 700 |
| H02 first edit after a settled reload, drilled / lettered |     556 / 260 |                        850 / 400 |
| H02 edit typed during the reload, drilled / lettered      |     854 / 577 |                      1,300 / 900 |
| H02 within-run ratio (2026-09-17, retained)               |             — | first edit ≤ 1.5 × warm + 250 ms |
| W01 simple box, median / p95                              |       38 / 42 |                         60 / 100 |
| W01 100-feature history, median / p95                     |     121 / 132 |    150 / 170 (target 100, unmet) |
| 10 × 10 pattern preview, browser / Node                   | 7,524 / 7,612 |                  10,000 / 10,000 |

The numbers hold for this machine only. On another machine, record a
baseline with the same command before reading a budget. Still open: a real
integrated-GPU device, the software renderer, and the hammer holder (once
its recipe passes preflight).
