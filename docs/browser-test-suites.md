# Browser test suites

Regular CI runs a focused **smoke suite**, selected by the `@ci-smoke` tag.
This intentionally trades the extended regression matrix for a faster check:
startup and sign-in, desktop and phone entry, create/edit/cancel/undo, a few
representative exact operations, import/export, save/reload, cloud sync and
encrypted sharing. Assertions within those journeys remain unchanged.

The full suite still contains the detailed geometry, interaction races,
breakpoint/theme combinations and historical regressions. It is not run on
ordinary PRs. An untagged new regression is therefore full-suite coverage only.
Tag a representative user journey when adding a major capability; keep the
smoke suite small instead of tagging every variant.
The staged v8 workflow additionally selects changed regression files and
runs all their cases, including untagged cases. It adds combined-tree queue
journeys and daily full qualification; see [CI qualification](ci-qualification.md)
for the activation sequence. The active v6 workflow retains its current
selection until the separate activation PR lands.

## Running a suite

- `pnpm test:e2e`: full suite locally; smoke suite when `CI` is set.
- `OPENZCAD_E2E_SUITE=smoke pnpm test:e2e`: smoke suite locally.
- `pnpm test:e2e:full`: explicitly full, including when `CI` is set.
- `OPENZCAD_E2E_SUITE=full`: opt a sharded CI/manual run into the full suite.

Performance probes, documentation and look-development captures (`OZ_PERF`,
`OZ_CAPTURE`, `OZ_LOOKDEV`, `H02_SESSION_PROBE=1`) keep their full selection
by default, so a focused untagged probe is not filtered away. Unknown suite names fail immediately.
Both suites retain the existing timeouts, retries and two-worker CI budget.

## Viewport frame timing (iPad proxy)

`test/e2e/perf-frame-timing.spec.ts` (`OZ_PERF=1`, weighted 0, never in CI)
measures how smoothly the viewport orbits heavy curved parts on an
iPad-class **proxy**: desktop Chromium with an iPad Pro-sized touch viewport
(1366 × 1024, device pixel ratio 2, coarse pointer, so the touch render
budget applies), CDP CPU throttling of the page's main thread (×1, ×4, ×6),
and a one-finger orbit sent through Chromium's touch input domain. On
Windows it runs WebGL on the machine's GPU through ANGLE D3D11 (headless
Chromium otherwise falls back to SwiftShader). It does not model Safari,
an iPad GPU, thermal throttling or 120 Hz ProMotion; treat its numbers as
relative, build against build.

```bash
VITE_E2E=1 OZ_PERF=1 pnpm --filter @openzcad/web build
pnpm --filter @openzcad/web preview --host 127.0.0.1 --port 24651
OZ_PERF=1 OZ_PERF_LABEL=main PLAYWRIGHT_PORT=24651   pnpm exec playwright test test/e2e/perf-frame-timing.spec.ts --workers=1
node scripts/frame-timing-report.mjs --compare   before=artifacts/perf/pre-r1,artifacts/perf/pre-r2   after=artifacts/perf/main-r1,artifacts/perf/main-r2
```

Each scene (`test/fixtures/frame-timing-scenes.ts`) and rate writes a JSON
file and a screenshot to `artifacts/perf/<label>` (git-ignored), plus
`summary.{json,md}`: requestAnimationFrame intervals (p50/p95/p99), refreshes
dropped at 60 Hz, the viewer's own CPU time per frame (`oz:viewer.frame`),
GPU time per frame from `EXT_disjoint_timer_query_webgl2` where available,
and the body install (`oz:viewer.bodies`, which includes building the
curved-outline candidates; an `oz:viewer.silhouettes` mark is recorded too
if a build emits one). Knobs: `OZ_PERF_THROTTLE`, `OZ_PERF_SECONDS`,
`OZ_PERF_SCENES`, `OZ_PERF_PORTRAIT=1`, `OZ_PERF_GPU_TIMER=0`,
`OZ_PERF_SOFTWARE_GL=1`. Other agents' builds share the machine, so run
each build several times, interleaved, and report the spread.

On a real iPad: Settings → Advanced → Frame rate overlay shows the live
frame interval while orbiting. For a timeline, connect the iPad to a Mac,
enable Web Inspector (Settings → Apps → Safari → Advanced) and record
Safari's Timelines on the open project; the `oz:viewer.bodies` measure
appears under User Timing, and the rendering frames show per-frame cost.

## Sharding and timing

Both suites use the existing six shards and required E2E completion gate.
The immutable fleet workflow and its runner restrictions are unchanged.
The sharder selects files containing the smoke tag, and Playwright selects
tagged cases within those files. An empty shard fails rather than publishing
an empty success. Merge candidates run five tagged save/history canaries
against the combined tree instead of the six shards.

Full measurements live in `test/e2e/shard-weights.json`; smoke measurements
live in `test/e2e/smoke-shard-weights.json`. Initial smoke weights sum the
selected cases from a successful hosted full-suite run. Refresh them from
completed reports:

```bash
node scripts/e2e-shards.mjs --suite smoke --update /path/to/e2e-report-*.json
node scripts/e2e-shards.mjs --suite full --update /path/to/full-report-*.json
```

Reports name their suite in `config.metadata.e2eSuite`. Updating weights from
the other suite is refused, so short smoke timings cannot corrupt the full
suite's balancing. Older reports without suite metadata count as full runs.

Newly affected specs can run without timing estimates, using the conservative
60-second default and emitting a warning. Committed smoke specs still require
complete timing entries. Inventory, exact-once assignment, nonempty shards and
stale/invalid weight checks remain enforced. Refresh timing
weights from successful reports for the current kernel rather than mixing
older kernel performance into the balance.

CI records a trace on the first retry and screenshots on failure. The v8 callee
retains passing timing/bundle reports for seven days and failures for fourteen,
including browser failure contexts. Daily qualification keeps every full-suite
case, coverage, its single attempt and seven-day artifact retention. Privacy
receipts and CodeQL caches have their own retention policies.

## Face-preview main-thread timing

`test/e2e/perf-face-drag-trace.spec.ts` (`OZ_PERF=1`, never a CI timing gate)
measures pointer-to-preview and release-to-authoritative-frame latency. The
`width from 30` case shrinks a public filleted-union surrogate to 22.5 mm;
`long native history` stresses the same path after 25 features. A supplied
native backup can be selected through `OZ_FACE_DRAG_PROJECT`. Model limitations,
the exact commands and measured diagnosis are in
[face-drag main-thread work](qa/2026-11-09/face-drag-main-thread.md).
`two committed face resizes` repeats the recording's R2 filleted-union shape:
two drags, each traced through its commit's successful save, with an
`afterRelease` frame summary. `OZ_FACE_DRAG_COMMIT_BUDGET_MS` turns its
post-release main-thread tasks, measured from a Chrome trace, into a local
budget; see
[face-commit hitches](qa/2026-11-11/face-commit-hitches.md).

On Linux, set `OZ_FACE_DRAG_ANGLE=gl` when the machine has a working hardware
OpenGL backend; the JSON records the actual WebGL renderer. Default headless
Chromium may use SwiftShader, whose GPU waits obscure main-thread comparisons.
Use one worker and serial, repeated runs. `OZ_FACE_DRAG_PROFILE` and
`OZ_FACE_DRAG_TIMELINE` save optional CPU profiles and Chrome timelines outside
the repo. The JSON includes raw frames/long tasks and separates motion from
settle/release; interval p99 and >25 ms counts exclude intentional idle frames.
