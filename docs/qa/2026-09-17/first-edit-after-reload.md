# First parameter edit after reload (H02)

Measured 2026-09-17 against OpenZCAD `main` at `a7b831c2`, Remus pin
`325c5bc3` (`remus-wasm` 2.130.22-era packages). Roadmap row
[H02](../../../ROADMAP.md#h02) asked for the reported 18–31 s first edit after a
reload to be characterised on named hardware, its bottleneck identified, and a
justified regression budget pinned. Raw per-run samples:
[`first-edit-after-reload-samples.json`](first-edit-after-reload-samples.json).
Probe: `test/e2e/perf-holder-reload.spec.ts` (`OZ_PERF=1`).

## Result

**Once a reload has settled, the first parameter edit costs the same as any
warm edit.** The exact history cache restores its checkpoint prefix from the
reload's own rebuild, so the first edit replays only the features after the
edited parameter's first consumer (5 of 15 on the drilled holder, 15 of 31 on
the lettered one) — exactly what a warm edit replays. The only "first edit after
reload" penalty is an edit typed _before_ the cold rebuild has finished: it
queues behind that rebuild and pays for it once.

**The 18–31 s report is not reproduced** on either redistributable holder, in
the production build or on the Vite dev server. The largest number recorded
here is 9.0 s, for an edit typed immediately after a reload on the dev server.
The reported figure came from the private hammer on a dev build at PR 7
(2026-09-11), before #296, #321 and #322; the untested variable that remains is
that file's measurement cost (see _Bottleneck_), which scales with the face
count the redistributable holders do not have. The probe accepts a private
file locally (`OZ_PERF_HOLDER_STEP`) so that run can close the row without
publishing the fixture.

## Hardware and build

| Item    | Value                                                                          |
| ------- | ------------------------------------------------------------------------------ |
| Machine | Apple M5 Pro, 15 cores, 48 GiB, macOS 26.6.2, mains power, no other load       |
| Browser | Playwright 1.62.1 headless Chromium 151.0.7922.34, fresh context per run       |
| Build   | `VITE_E2E=1 pnpm --filter @openzcad/web build` served by `vite preview`        |
| Dev     | `VITE_E2E=1 vite` dev server on the same checkout (unminified, no compression) |
| Node    | 22.23.1                                                                        |

Times are main-thread receipt of the worker's `ready` state, measured from the
Enter keypress (edits) or from navigation (reload). Stage durations are the
worker's own `performance.now()` deltas, taken from the `[geometry rebuild]`
console log the app already emits.

## Fixtures

| Fixture                                             | Features after Apply | Body                                                  |
| --------------------------------------------------- | -------------------: | ----------------------------------------------------- |
| `test/fixtures/hammer-holder/synthetic-holder.step` |                   15 | drilled arms, opening + mounting-hole recipes applied |
| `test/support/lettered-holder.ts` (kernel-built)    |                   31 | raised lettering, holder + text recipe applied        |

## Production build, medians of three runs

| Scenario (ms)                         | Drilled holder | Lettered holder |
| ------------------------------------- | -------------: | --------------: |
| Reload → exact ready                  |          2,370 |           2,175 |
| Warm edit before reload               |          1,461 |             343 |
| **First edit after settled reload**   |      **1,218** |         **328** |
| Second edit after reload              |          1,286 |             332 |
| Edit typed immediately after reload   |          1,932 |             331 |
| Preview shown after an immediate edit |          2,972 |               — |

An earlier batch of three on the same build put the drilled holder's reload at
1,562–1,605 ms; both batches are retained in the samples. Nothing distinguishes
the first edit after reload from the second, on either fixture.

## Dev server, medians of two runs

| Scenario (ms)                       | Drilled holder | Lettered holder |
| ----------------------------------- | -------------: | --------------: |
| Reload → exact ready                |          6,730 |           3,985 |
| Warm edit before reload             |          2,340 |             404 |
| First edit after settled reload     |          1,637 |             456 |
| Edit typed immediately after reload |          6,043 |           4,450 |

The dev server roughly triples the reload (4.5–9.0 s on the drilled holder)
and an immediate edit inherits all of it. Settled edits are unaffected.

## Where the time goes

Worker-measured medians, production build, drilled holder:

| Stage                                | Reload rebuild | First edit after reload |
| ------------------------------------ | -------------: | ----------------------: |
| Measurement of the top-level body    |       1,182 ms |                  997 ms |
| └ Planar distance edit proofs        |         721 ms |                  608 ms |
| └ Display mesh and face topology     |         155 ms |                   87 ms |
| └ Imported feature recognition       |         131 ms |                  128 ms |
| └ Opening recognition                |         100 ms |                   90 ms |
| Building history (features replayed) | 336 ms (15/15) |           100 ms (5/15) |
| Loading imported sources             |          24 ms |                       — |

On the lettered holder every stage is under 100 ms and an edit is ~330 ms.

### Bottleneck

Per edit on a drilled holder, **measurement of the edited body dominates, not
history replay**: about 1.0 s of a 1.2 s edit, of which the planar-distance
edit proofs (`provenOpposingPlanarFacePairs`) are 0.6–0.7 s. The measured-shape
cache only serves an unchanged body, and a parameter edit produces a new one,
so this runs on every preflight sync. The reload adds only the full replay
(0.34 s) and the kernel load on top.

Candidates, in order of expected return, none implemented here:

1. Defer the planar-distance proofs to the moment a direct edit needs them (a
   face pick), or cache them by the face-pair geometry rather than the body.
2. Skip imported-feature and opening recognition on a preflight sync whose
   only purpose is validating a parameter edit.

## Budget

Pinned from these runs, checked by the probe when `OZ_PERF_BUDGET=1`:

- First edit after a settled reload ≤ 1.5 × the same run's warm edit + 250 ms.
- Edit typed before the reload settles ≤ that reload's time to exact ready +
  one warm edit + 250 ms.

Both are ratios within one run, so they hold across machines; an absolute
number would not (the two production batches differ by 0.8 s on the reload
alone). A failure means the history cache no longer restores its prefix after
a reload, or an edit no longer queues behind the reload it was typed into.

## Observed while measuring, not part of H02

The first parameter edit typed right after applying the second verified
suggestion on the drilled holder is refused every time with "The project or
parameter changed during validation. Try again." (3/3 production, 2/2 dev). The
field keeps the typed value, the document does not, and a second attempt
succeeds. The lettered holder's single suggestion does not trigger it. Tracked
against U02; the samples labelled "first edit after assistant apply" carry the
refusal text.

Follow-up (#359): the probe's Apply wait matched the previous recipe's
already-applied card, so that edit was typed while the second patch was still
in exact preflight; the patch then landed a new document version under the
edit's check. The product now waits for a landing patch and re-validates on the
moved document, and the probe counts applied cards before running on.
