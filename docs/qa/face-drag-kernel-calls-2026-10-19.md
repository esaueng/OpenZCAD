# Face-drag kernel calls and document scaling, 2026-10-19

H02 evidence. These numbers measure what the exact adapter asks Remus to do
during an offset-face drag, through `test/perf/offset-face-perf.test.ts` in
Node. They are the Phase 0 baseline for the kernel edit-latency review. They
exclude the worker protocol, transfer, viewer installation and the GPU, which
[face-drag-latency-2026-10-18](face-drag-latency-2026-10-18.md) covers.

## Setup

| Item           | Value                                                                                                          |
| -------------- | -------------------------------------------------------------------------------------------------------------- |
| OpenZCAD       | `bde9fbd` plus this harness change                                                                             |
| Pinned kernel  | Remus `0882e17`, remus-wasm 2026.1.66, WASM SHA-256 prefix `8bc0b80f78453dec`                                  |
| Overlay kernel | Remus `59d02a1` committed package 2026.1.68, prefix `4acde153b577e2d2`, through `REMUS_WASM_PKG`               |
| Host           | 4-vCPU cloud container, Intel Xeon @ 2.10 GHz, Node 22.22.0, pinned to one CPU with `taskset`. One run per row |
| Fixture        | Remus `crates/io/tests/data/shapr3d_hammer_holder.step`: 160 faces, 42 NURBS                                   |
| Edit           | Largest +X planar face, offset −6, display-only drag path (`OFFSET_PERF_DEFER_TOPOLOGY=1`)                     |
| Drag           | 40 source-relative warm ticks after the first preview, 0.2 apart, out to −8 and back every 20 ticks            |

```sh
OFFSET_PERF_STEP=<remus>/crates/io/tests/data/shapr3d_hammer_holder.step \
OFFSET_PERF_PREVIEW=1 OFFSET_PERF_DEFER_TOPOLOGY=1 OFFSET_PERF_PREVIEW_TICKS=40 \
OFFSET_PERF_OUT=drag.jsonl OFFSET_PERF_CALLS_OUT=calls.jsonl \
  pnpm exec vitest run -c test/perf/offset-face-perf.config.ts \
  --reporter=verbose --silent=false
```

Add `REMUS_WASM_PKG`/`REMUS_WASM_IO_PKG` for the overlay kernel and
`OFFSET_PERF_BACKGROUND_BODIES=200` for the large document.

## Results

Milliseconds over the 26 accepted warm ticks. The other 14 ticks were refused
(see below).

| Run                                    | Wall p50 / p95 | Kernel p50 / p95 |                                Move |        Display mesh | Kernel calls per tick | Commit sync wall |
| -------------------------------------- | -------------: | ---------------: | ----------------------------------: | ------------------: | --------------------: | ---------------: |
| Pinned 2026.1.66                       |  187.6 / 260.9 |    135.9 / 227.9 |         16.6 (`moveFacesJournaled`) |                65.6 |                 9,943 |            1,482 |
| 2026.1.68 overlay                      |  166.0 / 214.2 |    127.7 / 170.2 | 14.7 (`moveFacesPreparedJournaled`) |                60.7 |                 9,943 |            1,325 |
| 2026.1.68 overlay, 200 unrelated boxes |  555.0 / 685.2 |    268.4 / 340.0 |         15.9 (`moveFacesJournaled`) | 75.0 over 201 calls |                94,887 |            1,978 |

## Findings

1. **About 10,000 kernel calls per drag tick.** Most are per-face and per-edge
   reads made between kernel operations: 1,376 `edgeLength`, 3,020
   `evaluateEdgeCurve`, 624 `getEdgeNurbsData`, and the vertex and curve-type
   reads that build preview face keys and witnesses. `edgeLength` alone is a
   12 ms median per tick. The move itself is 15–17 ms.
2. **Unrelated bodies multiply each tick's cost.** With 200 boxes ahead of the
   import:
   - every tick re-meshes all 201 bodies;
   - every tick re-reads every body's faces and edges;
   - kernel calls rise 9.5× and accepted wall time 3.3×;
   - the JavaScript share rises from about 40 ms to about 290 ms.
3. **Prepared moves do not engage in that large document.** The edit is no
   longer right after a retained checkpoint, so each tick replays from the
   nearest checkpoint (`deserializeSolids` and `makeBox` show up per tick) and
   takes the unprepared `moveFacesJournaled`.
4. **The session kernel's arena grows on every tick.**
   - In the base runs, allocated slots rise from 6,434 to 109,358 across the
     40 ticks: about 2,600 per tick, 96% of them retired.
   - Kernel linear memory grows by 22–26 MB over those ticks.
   - Restoring a checkpoint leaves the slots that each frame allocated as
     retired tombstones. Remus's `Arena` iteration and live counts are
     O(slots), so long drags slow every later whole-arena walk.
5. **Inward moves past about −7.4 are refused.** That is 14 of 40 ticks. The
   kernel's message names both exact paths:
   - the blend remove/rebuild refuses the band's mixed plane/cylinder support;
   - the prismatic translation fails validation with wire self-intersections.

   Refused ticks still cost a full tick (wall p50 160–166 ms), because the
   adapter runs the attempt and keeps the last accepted shape.

6. **The prepared move saves little on this body.** It is 14.7 versus 16.6 ms
   median. The holder takes the blend translation path, where most per-frame
   work happens after preparation.
7. **The commit is dominated by analysis.** On 2026.1.68 the commit sync
   spends `volume` 352 ms, `solidEdgeRelations` 332 ms and `recognizeFeatures`
   331 ms, against an 18.8 ms move.

## Not measured here

- The worker's second, broadcast sync after a commit.
- `structuredClone` and `postMessage` costs.
- Viewer installation.
- Browser WASM tiering.

`test/e2e/perf-face-drag-trace.spec.ts` covers the browser path.
