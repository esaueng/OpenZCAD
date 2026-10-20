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
   - Restoring a checkpoint retires the slots each frame allocated. That is
     by design: Remus never reuses a slot, so a stale handle cannot alias a
     later entity.
   - Remus's 200-tick kernel-only replay (esaueng/remus#1188) finds no tick
     slowdown from this growth, so it costs memory rather than time.
     Reclaiming the memory is the arena-compaction work (PERF-T06).
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

## Follow-ups measured the same day

- **The post-commit broadcast sync is cheap in the adapter.**
  - The app commits with a full-lineage sync. The new document version then
    triggers a broadcast sync with an empty lineage demand, which misses the
    worker's result cache.
  - Replayed through the adapter (`OFFSET_PERF_BROADCAST=1`), that second
    sync of the hammer holder takes 42 ms wall, 5 ms of it in the kernel,
    after a 1,663 ms commit sync.
  - The adapter's history and measured-body caches absorb it, so merging the
    two worker cache keys is a small win, not a priority.
- **Drag previews now reuse the committed measurement of unchanged bodies.**
  - A body qualifies when it keeps its solid handles, lineage, import
    diagnostics and recounted handle/validation witness. Its last complete
    measurement is then published in the deferred-preview shape instead of
    being re-meshed.
  - With 200 unrelated boxes, interleaved 6-tick runs went from a wall p50 of
    608/633 ms to 525/484 ms, and from a kernel p50 of 305/305 ms to
    261/246 ms. The single-body holder is unchanged.
  - Two limits remain:
    - **Rebuilt bodies.** 57 of the 200 boxes sit after the nearest retained
      checkpoint. They are rebuilt with new handles on every tick, which is
      the sparse-checkpoint cost.
    - **Refusals.** In the 40-tick run, reuse stopped after the first refused
      ticks (7 and 8). Every later tick re-meshed all 201 bodies. The cause is
      not yet traced; the measured-body cache only refills on a complete sync.
  - A CPU profile of a 6-tick run spends 380 ms in `structuredClone` inside
    `syncMeasuredDocument`, across the import, the previews and the commit
    together. The preview's final clone of every body's state is the remaining
    per-tick candidate.

- **The preview face-geometry cache roughly breaks even.**
  - Turning it off left the holder's tick p50 unchanged within noise: 229–258
    vs 234–244 ms on 2026.1.66, and 167–195 vs 158–184 ms on 2026.1.68.
  - Its key cost about what it saved, because building it reads about 10 kernel
    values per edge on every face.
  - Two exact reductions now cut `edgeLength` reads from 1,376 to 410 per tick
    (12.4 → 4.0 ms on 2026.1.68):
    - The key no longer reads edge lengths. Five quantized samples along each
      edge, its curve type and its NURBS definition already determine the
      curve.
    - Face witnesses read each edge length once per sync memo, instead of
      once for each of the edge's two faces. Summation order is unchanged, so
      perimeters stay bit-identical.
  - Removing the remaining key cost needs a kernel-side per-face content
    digest, so the adapter can skip the witness, the key and the measurement
    for faces that are unchanged.

- **Drag previews now checkpoint the feature right before the dragged edit.**
  - Before, a drag past the first 16 features restored the nearest stable
    checkpoint and replayed everything after it on every tick. The edited
    body then got new handles each tick, so the prepared move never engaged
    (finding 3).
  - A drag preview now also checkpoints the feature right before the edit.
    Every later tick restores that checkpoint and replays only the edit. The
    next sync that is not a drag preview discards the extra checkpoint, and
    the stable positions are unchanged.
  - Holder behind 200 unrelated boxes, 2026.1.68 overlay, 12 ticks (6
    accepted), one run each, same host:

    | Run    | Accepted wall p50 / p95 | Kernel p50 / p95 | Move                                 | Linear memory growth |
    | ------ | ----------------------: | ---------------: | ------------------------------------ | -------------------: |
    | Before |           405.1 / 483.1 |    202.7 / 251.0 | `moveFacesJournaled` 27.6 ms         |              21.2 MB |
    | After  |           259.5 / 392.2 |    148.6 / 227.0 | `moveFacesPreparedJournaled` 28.8 ms |               8.8 MB |

  - `deserializeSolids` no longer runs per tick. Each tick still meshed 57
    bodies, because the measured-body cache only refilled on a complete sync
    and those bodies got new handles on the drag's first tick (next item).
  - Regression: `test/drag-source-checkpoint.test.ts`. With the change
    reverted, every tick replays the dragged extrusion.

- **Drag previews keep their own meshes of bodies they rebuilt.**
  - A body the drag's first tick replays gets new handles, so its committed
    measurement no longer matches and every later tick meshed it again.
  - A drag preview now keeps the display it meshed for each body, keyed and
    checked exactly like the committed measurement: the same solid handles,
    lineage and import diagnostics, and a recounted handle/validation witness.
    Later previews publish it while the body is unchanged.
  - The entry holds no volume, edges or recognition, so it only serves
    previews. A complete measurement of the body replaces it.
  - Same run as above, one run each:

    | Run    | Accepted wall p50 / p95 | Kernel p50 / p95 | Bodies meshed per tick | Refused wall p50 |
    | ------ | ----------------------: | ---------------: | ---------------------: | ---------------: |
    | Before |           250.0 / 321.1 |    151.2 / 195.8 |                     57 |            242.9 |
    | After  |           194.8 / 256.8 |    129.7 / 163.4 |                      1 |             96.1 |

  - Regression: the second test in `test/preview-measured-body-reuse.test.ts`.
    With the store removed, the untouched extrusion is meshed on every tick.

## Not measured here

- `postMessage` costs.
- Viewer installation.
- Browser WASM tiering.

`test/e2e/perf-face-drag-trace.spec.ts` covers the browser path.
