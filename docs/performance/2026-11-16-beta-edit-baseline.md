# Local beta CAD edit baseline

The retained changes reduce median input-to-render latency by **50.6%**, or
**2.03×**, on the large-history workload. Each of its three matched comparisons
cleared 2×. The 100-history case improves by 40.5%, or 1.68×. Simple-box timings
remain similar.

These measurements use local production builds on an RTX 3090. The 2× result
applies to the large-history workload. Integrated-GPU and deployed-beta
qualification remain open.

## Results

All durations are milliseconds. Quantiles use the probe's nearest-rank method.
The pooled large-history result combines 90 edits per build. Each other result
contains 30 edits per build.

| Workload                             | Features during measurement | Baseline median | Candidate median | Speedup | Baseline p95 | Candidate p95 |
| ------------------------------------ | --------------------------: | --------------: | ---------------: | ------: | -----------: | ------------: |
| Simple box                           |                           1 |            36.4 |             35.9 |   1.01× |         40.2 |          41.6 |
| 100-history setting, isolated source |                         101 |           112.5 |             66.9 |   1.68× |        130.2 |          77.1 |
| 500-history setting, isolated source |                         501 |           514.4 |            253.9 |   2.03× |        559.3 |         286.5 |

The history settings seed 99 or 499 boxes and one dependent move. The probe
then creates one more Box through the UI before editing the first source.
Context-part visibility is configured through the existing parameter toggle.
The 500-history case extends the original 100-history coverage to large-model
scaling.

| Large-history comparison | Run order           | Baseline median | Candidate median | Speedup |
| ------------------------ | ------------------- | --------------: | ---------------: | ------: |
| 1                        | Baseline, candidate |           519.1 |            253.9 |   2.04× |
| 2                        | Candidate, baseline |           511.3 |            254.2 |   2.01× |
| 3                        | Baseline, candidate |           508.3 |            250.6 |   2.03× |

The companion CSV contains 300 measured edits across the five matched pairs.
The provenance record includes per-run phase summaries, host conditions,
source hashes and frozen-build identities. [Samples](2026-11-16-beta-edit-baseline.samples.csv),
[provenance](2026-11-16-beta-edit-baseline.provenance.json).

## Method

The existing browser probe measures from the applied input event through the
explicit exact-worker reply, adoption of that revision's bodies, and a completed
viewport render carrying the same revision. Each run applies 30 unique widths
from 12.0 through 14.9. Assertions require the expected body width, successful
rebuilds, zero model warnings and zero browser runtime errors. Its
`bodyInstallationMs` field spans the response-to-install interval and includes
work before installation. The end-to-end metric is `inputToFrameMs`.
[Probe](../../test/e2e/perf-cad-edit.spec.ts).

The machine uses an AMD Ryzen 9 5900XT, Chromium 156.0.8078.4, Node 24.22.2,
ANGLE OpenGL on NVIDIA RTX 3090, a 1440×1000 viewport and device pixel ratio 1.
Both builds use the paired Remus 2026.1.141 packages from immutable commit
`3c489d7d3429615b78f3c266317b1cf280ed45a6`.

Each build runs after three quiet samples spaced five seconds apart. Gates
require one-minute load below 2, at least 3 GiB available memory, GPU usage
below 20%, an exited Folding@home core and zero competing build/test processes.
Host conditions are checked again afterward. Folding@home pauses only for the
authorized measurement windows, with a watchdog and a `finally` restoration.
Restoration to the original mode was verified after every reported pair.

The baseline is commit `5b6cff7d8ffe3d3eb5a20633f23a1f66b0b87e22`. The
candidate was measured before committing, using the 20-file source manifest in
the provenance record. Both build stamps therefore identify the base commit.
The frozen candidate and baseline build-meta hashes distinguish their outputs.
All reported measurements use that same retained candidate source.

## Retained changes

- Long History and Objects panels mount visual details near the scrollport.
  Every action button and accessible name remains mounted. Focus, selection,
  dragging and portaled menus keep their row expanded.
- Closed body-binding details defer their checkbox list until opened.
- Worker replies copy transferable mesh buffers once. The real `postMessage`
  clones their metadata, while adapter and cache buffers retain ownership.
- Cache size accounting reuses immutable geometry estimates and recounts
  mutable metadata. Exact measurement provenance uses equivalent canonical
  JSON with fewer serializer callbacks.
- Explicit sync replies cache bounded, lossless topology text. The negotiated
  v2 encoding restores own `undefined` properties. Unsupported graphs use the
  existing structured-clone path, and decoding validates the full publication
  before adopting any topology.

Experiments in row memoization, incremental topology alias accounting,
layout containment, focus scheduling and animation removal showed little
additional end-to-end benefit and were removed.

## Verification

All required local checks pass on the retained source.

- `pnpm lint` passes with 18 existing warnings.
- `pnpm typecheck` passes.
- `pnpm test` passes 12,370 root tests and 7,502 web tests. The root project
  retains its existing 22 skipped tests.
- `pnpm test:parity-corpus` passes 97 tests with one existing skip.
- `pnpm build` passes artifact integrity and bundle-size gates.

The focused browser run passes 16 cases covering full accessibility-tree
presence, reverse Tab, rename and context actions, rail navigation, immediate
online/offline reload, blocked-save recovery, and exact face-edit readiness
after cached reload. The face-edit case uses the full-render E2E build with its
selection hooks enabled.

Independent read-only Claude Opus 5.5 reviews covered the retained UI/cache
changes and topology transport. The UI review's two accessibility findings were
fixed by retaining action controls. The transport review's optional-undefined
finding was fixed by v2 markers. Scoped rechecks reported no blocking findings.
Reviews used read-only inspection. Command and browser verification above
come from this implementation session.

## Reproduction

Build the baseline commit and candidate source in separate checkouts with the
same installed package pair. Serve each production build on a distinct port.
For example, start one build with

```bash
pnpm build
pnpm --filter @openzcad/web preview --host 127.0.0.1 --port 24672 --strictPort
```

With that server running and the host quiet, measure its large-history case

```bash
OZ_PERF=1 OZ_PERF_ANGLE=gl PLAYWRIGHT_PORT=24672 \
CAD_PERF_BROWSER_HISTORY=500 CAD_PERF_BROWSER_ISOLATE=1 \
CAD_PERF_BROWSER_SAMPLES=30 CAD_PERF_BROWSER_OUT=/tmp/oz-perf-before.json \
pnpm exec playwright test test/e2e/perf-cad-edit.spec.ts --workers=1
```

Repeat against the candidate's port and a separate output file, then reverse
build order for the second pair. Use history settings 100 and 1 for the other
cases. Restore any paused GPU workload after each bounded comparison window.
