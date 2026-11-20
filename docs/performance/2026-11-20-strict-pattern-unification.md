# Strict face unification in overlapping linear patterns

The preview needs to choose a solid. Remus can make that decision by checking the merged candidate, while OpenZCAD still rejects a candidate whose display mesh is open. Callers that need a strict report for the raw union keep the existing API. The optional binding activates when a paired Remus release with this method is installed.

## Browser measurements

Eight fresh Chromium sessions per build and size ran on Linux with an RTX 3090. Four builds rotated order across blocks. The clock ran from the keypad input event to Done becoming enabled for the matching exact preview. Each session used a radius-5 mm, height-10 mm cylinder. The operator opened Linear pattern, set spacing to 6 mm, changed count to 11, 12 and the final count, then tried five new spacings.

| Copies | Spacing (mm) | Historical (ms) | Worker build (ms) | Same kernel source before change (ms) | With strict candidate (ms) | Historical speedup |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 13 | 7 | 192.7 | 100.5 | 101.6 | 84.1 | 2.29× |
| 13 | 6.25 | 180.2 | 92.2 | 88.1 | 85.2 | 2.12× |
| 13 | 6.5 | 175.1 | 98.4 | 90.9 | 79.4 | 2.21× |
| 13 | 6.75 | 177.6 | 93.0 | 91.1 | 78.4 | 2.27× |
| 13 | 7.25 | 212.1 | 104.9 | 105.2 | 96.9 | 2.19× |
| 25 | 7 | 324.6 | 145.4 | 143.3 | 131.5 | 2.47× |
| 25 | 6.25 | 280.3 | 122.0 | 127.0 | 111.1 | 2.52× |
| 25 | 6.5 | 277.9 | 122.9 | 117.6 | 106.8 | 2.60× |
| 25 | 6.75 | 303.2 | 120.7 | 124.1 | 106.8 | 2.84× |
| 25 | 7.25 | 309.1 | 147.8 | 145.0 | 135.1 | 2.29× |

The pooled spacing medians were 183.2 → 83.8 ms for 13 copies and 303.2 → 115.0 ms for 25 copies. The first count change to 11 in the 13-copy trial took 145.4 ms historically, 134.4 ms on the worker build, 149.5 ms on the same-source control and 161.2 ms on the candidate. The first overlap at 6 mm took 201, 201, 204 and 189 ms respectively. Timings include worker startup.

The historical app was `1ccd730415f89742c3665d91aae7661912fc8505`. The worker app was `48b5699d976401b4a8ceedec605511fd7b36ecfe` with its release pin. Both local kernel builds used Remus `18131dfaa12220b42619457a33c17223879fa274` as the source baseline, and both overlay builds used the same app code. The control core SHA-256 was `c75453e2db0d9c52068f80a963649a67465399b871a675408988b26d9260858e`; the candidate was `60eb3867a09be351a0a421120f01651ca7fabed88acf11d0ae632a5df544e93d`. IO bytes matched. The timed build preceded a cleanup on the exception fallback. That cleanup, the closed-mesh regression and both bindings were tested separately.

The ten preview results per session matched across all four builds. A separate browser worker corpus compared complete body representations, warnings and normalized STEP output for 28 documents with working helpers, refused jobs and silent helpers. Six interleaved isolated runs of nine captured pattern solids matched at the serialized B-rep, detailed validation, mass properties, area, volume and merged-face count. For new spacings the kernel unification step took 24.5–28.8 ms on the control and 14.2–15.8 ms on the candidate.

## Reproduction

Use the [linear spacing probe and build instructions](2026-11-20-parallel-linear-intersections.md#reproduction) for each comparator. For the kernel comparison, build both core and IO packages from source with `cargo xtask wasm-build` and point each app build at its respective pair using `REMUS_WASM_PKG`, `REMUS_WASM_IO_PKG` and `OZ_ALLOW_LOCAL_REMUS=1`. Set `OZ_PERF_OUT` to a fresh file for every run.
