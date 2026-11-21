# Grid preview timing and repeated row unions

The one-body fixture starts its default grid when the user clicks Grid pattern. Typing a valid count in the keypad starts the next preview. The previous benchmark opened and closed the Objects panel and selected the already-selected body before observing Done, and started its count timer after the keypad input. The revised probe captures the tool click or keypad input, then observes the pending preview become eligible to commit. Its JSONL records carry `timingVersion: 2`.

## Matched Chromium runs

Samples are milliseconds until Done becomes available for that grid. Each comparison used fresh pages in baseline/candidate, candidate/baseline, baseline/candidate order on a Ryzen 9 5900XT and RTX 3090 with ANGLE OpenGL. Each app built its fixture at its own document schema version. Other validation ran on this host during part of the measurements.

| Comparison                    | Grid  | Baseline samples | Candidate samples | Median speedup |
| ----------------------------- | ----- | ---------------- | ----------------- | -------------: |
| Original row fusion           | 3x3   | 563, 553, 681    | 303, 300, 326     |          1.86× |
| Original row fusion           | 10x3  | 2243, 2277, 2310 | 918, 913, 944     |          2.48× |
| Original row fusion           | 10x10 | 7450, 7459, 7556 | 1524, 1471, 1549  |          4.90× |
| Retaining the exact first row | 3x3   | 309, 321, 322    | 316, 343, 313     |          1.02× |
| Retaining the exact first row | 10x3  | 925, 947, 986    | 946, 972, 936     |          1.00× |
| Retaining the exact first row | 10x10 | 1528, 1572, 1580 | 918, 950, 861     |          1.71× |

The historical comparison uses `1ccd73041` and `e8a764843` with their pinned kernel. The second comparison uses `b8aac7dbf` and that same app revision with one cached row per kernel. Those builds shared the lockfile, kernel pin and benchmark. Compare rows within each pair.

The fixture changes the first-axis count between 3×3 and 10×3. Only its second-axis count changes between 10×3 and 10×10. In two instrumented browser runs, that last edit submitted the same first-row operands as the previous edit. Repeating the row union took 670 and 681 ms. The browser benchmark exercises this sequence. A fresh 10×10 grid has no previously fused row to reuse.

A preceding three-pair run recorded 1510 to 816 ms on the same 10×3 to 10×10 edit. The final probe also associates diagnostic stages with the exact worker request.

The regression checks that a changed first-row operand causes a fresh union, and compares mesh, topology, volume and fixed-timestamp STEP with a fresh adapter.

To reproduce, copy the current `test/e2e/perf-pattern-preview.spec.ts` into both revisions, then run the following command in each checkout. Use a distinct output file for each run.

```sh
OZ_PERF=1 OZ_PERF_ANGLE=gl OZ_PERF_OUT=/tmp/grid-run.jsonl \
  pnpm exec playwright test perf-pattern-preview.spec.ts --workers=1
```
