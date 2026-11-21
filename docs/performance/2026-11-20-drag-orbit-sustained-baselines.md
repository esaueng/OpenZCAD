# Face drag, orbit and sustained-session baselines (2026-11-20)

This record adds three probes to the [Active 1 baselines](2026-11-15-active1-baselines.md)
for [ROADMAP](../../ROADMAP.md) [H02](../../ROADMAP.md#h02) and
[W01](../../ROADMAP.md#w01): face-drag targets, orbit frame-time tails and
sustained-session retention. Each probe has budgets in
`scripts/active1-budgets.mjs` that `node scripts/measure-active1-baselines.mjs --check`
enforces. The [owner-pending list](#owner-pending) names the measurements
this machine cannot make, each with its command.

## Machine and build

These figures come from the same machine as the 2026-11-15 record: a Ryzen 5
5600 with 15 GiB of RAM and a **discrete** Radeon RX 6600, Linux 7.0.0-43. It
has no integrated GPU. The browser was headless Chromium 156.0.8078.4 on
`ANGLE (AMD, Vulkan 1.4.335 (AMD Radeon RX 6600 (RADV NAVI23)), radv)`, and
every sample records that renderer. Source: OpenZCAD `main` at `9cbb2d4cf`
with this change's probes. Remus 2026.1.151.

The drag and orbit probes read frame marks that only an instrumented build
compiles in, so the script builds with `OZ_PERF=1` when either is selected.
It refuses to mix them with the other browser probes, whose 2026-11-15
baselines were taken on an uninstrumented build. Before each probe the host
had a load of 0.8–1.6 and 9.3–9.7 GiB available. Other agent sessions share
this machine, and every heavy job ran under the shared lock.

Two complete rounds of each probe were recorded. The third round was cut off
at a two-hour limit while waiting for the shared lock. Orbit's second round
also stopped in its last scene (`rotational-sleeve` at 4× slow-down, which
has one sample). Run-to-run spread was within 2 ms on every drag and orbit
row.

## Face drag (H02 targets)

```bash
node scripts/measure-active1-baselines.mjs --only face-drag,orbit --runs 3 --angle vulkan --check
```

`test/e2e/perf-face-drag-trace.spec.ts` streams 120 real pointer moves, one
every 16 ms, out and back along the offset handle, then releases. The
`face-drag` probe runs its four public cases. On current `main`, disposable
proxy frames follow the pointer, and the exact preview is built once the
hand rests. The summary therefore reports the proxy lag (what the user sees
while dragging) and the exact preview's round trip as separate rows.

| Case (medians of 2 runs)                     | Pointer → frame p50 / p95 | Frame interval p50 / p95 | Exact preview at rest | Release → accepted |
| -------------------------------------------- | ------------------------: | -----------------------: | --------------------: | -----------------: |
| Filleted union, width 30 → 22.5 mm (5 feat.) |                15 / 16 ms |             16.7 / 33 ms |                395 ms |              98 ms |
| Public filleted union history                |                14 / 16 ms |             16.7 / 33 ms |                179 ms |             160 ms |
| Rounded box top face                         |                15 / 16 ms |           16.7 / 16.7 ms |                     — |             167 ms |
| Native holder +Z face                        |                15 / 16 ms |           16.7 / 16.7 ms |                 64 ms |              76 ms |

**Targets** (H02: 60 fps, first geometry within 100 ms, p95 under 50 ms):

- **Pointer → frame p95 under 50 ms: met.** All four cases are at 15–16 ms.
- **First geometry within 100 ms: not established.** The proxy lag above
  is a median and p95 across all proxy frames, not a measure of the first
  one. The exact preview's round trip (64–395 ms) is worker time measured
  after the hand rests, not from the first move to the screen. Neither
  figure shows that exact geometry reached the screen within 100 ms of the
  first move, so this target is left unmeasured here.
- **60 fps: met at the median** in every case. The two filleted unions each
  drop one frame per drag (one 33 ms interval, so their p95 is 33 ms). The
  box and holder hold 16.7 ms at p95.

## Orbit tails

`test/e2e/perf-frame-timing.spec.ts` runs a 6-second one-finger orbit on an
iPad-sized touch viewport (1366 × 1024, DPR 2), unthrottled and at 4× CPU
slow-down. It covers seven scenes: rounded and filleted blocks, a 60-tooth
gear, a torus, a sphere row and a rotational sleeve. Every scene, at both
rates, drew 58.5–60 viewer frames per second, and no viewer frame
interval (`oz:viewer.frame`, the viewer's own frames rather than the page's
animation callbacks) exceeded 16.8 ms. The ordinary orbit tails noted as
open in H02 do not reproduce on this GPU.

## Sustained session

The `sustained` probe runs the long mode of
`test/sustained-session-retention.test.ts`: 300 edits of the public filleted
union through the worker's exact adapter, with idle compaction. The figures
are in the [sustained-session record](2026-11-20-sustained-session.md): WASM
memory peaks at 102 MB and retired slots at 66,194, while post-GC heap and
one-feature edit time stay flat.

## Budgets

Regression ceilings for this machine, about 1.5–2× the medians, with a floor
for frame intervals. They are not product targets, which are listed above.

| Measurement                                           |                   Budget |
| ----------------------------------------------------- | -----------------------: |
| Face drag pointer → frame p50 / p95, every case       |               25 / 30 ms |
| Face drag frame interval p50, every case              |                    20 ms |
| Face drag frame interval p95, filleted unions / rest  |               50 / 25 ms |
| Exact preview at rest, union / history / holder       |       600 / 280 / 120 ms |
| Release → accepted, union / history / box / holder    | 160 / 250 / 260 / 130 ms |
| Orbit viewer interval p95 / p99, viewer fps floor, ×1 |     20 / 25 ms, ≥ 55 fps |
| Orbit viewer interval p95 / p99, viewer fps floor, ×4 |     25 / 34 ms, ≥ 50 fps |
| Sustained: peak WASM memory                           |                  128 MiB |
| Sustained: peak retired arena slots                   |                  131,072 |
| Sustained: post-GC heap growth, first → last third    |                    4 MiB |
| Sustained: one-feature edit drift, last ÷ first third |                    1.15× |

`test/active1-summary.test.ts` (root CI) covers the summary rows: each drag
run judged by what followed its pointer, a run that recorded nothing failing
its row, orbit read from the viewer's own frames, and sustained peaks taken
over every sync rather than the sampled rows. Proxy-followed and exact-followed drag runs get separate rows, each over
its own runs, and the exact-preview row reads only the runs that asked for
one. The script stamps each build it makes with its flavour and the build's
output time (`perf-results/active1/.last-build.json`). A `--no-build` run
accepts only that unchanged build of the right flavour, or a hand-made build
the caller vouches for with `--assume-build plain|instrumented`. CI does not run the browser
probes, which depend on the machine; `pnpm typecheck` and `pnpm lint`
cover their code.

## Owner-pending

These measurements need hardware, a quiet host or private files that agent
sessions do not have. Each command is ready to run:

| Item                                                                                     | Why it is pending                                                                                                                                                            | Command                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H02 / W01 on an integrated-GPU device (Active 1 wording)                                 | This machine has only a discrete GPU                                                                                                                                         | `node scripts/measure-active1-baselines.mjs --runs 3 --angle <backend> --check`, then a second run with `--only face-drag,orbit`                                                    |
| Quiet-host H02 timing                                                                    | Other lanes share this machine; runs waited for load < 2                                                                                                                     | Same commands, on a dedicated host                                                                                                                                                  |
| Whole-worker heap in a browser worker on target hardware                                 | Measured here in Node with the worker's adapter                                                                                                                              | `node scripts/measure-active1-baselines.mjs --only sustained --check`, plus `H02_CACHE_MODE=enabled OZ_PERF=1 pnpm exec playwright test perf-holder-reload` for post-GC worker heap |
| Complex-fillet 2× target on the private 44-feature part (Windows, Intel UHD)             | The private file and device; Remus #1492 and OpenZCAD #1155 are on `main`, and the [2026-11-02 record](../qa/2026-11-02/complex-fillet-offset-performance.md) measured 2.30× | `OZ_PERF=1 OZ_FACE_DRAG_PROJECT=<backup> pnpm exec playwright test perf-face-drag-trace -g "supplied project"`                                                                      |
| Detached Text cache on the private holder (≥ 20% p95)                                    | The private holder STEP                                                                                                                                                      | `OZ_PERF=1 OZ_PERF_HOLDER_STEP=<file> OZ_PERF_HOLDER_PARAMETER=holder_height pnpm exec playwright test perf-holder-reload`                                                          |
| Restored-session first edit and cold-join (rim reconstruction) timing on target hardware | Device timing                                                                                                                                                                | `node scripts/measure-active1-baselines.mjs --only h02 --check`, plus the face-drag probe's "supplied project" case                                                                 |
