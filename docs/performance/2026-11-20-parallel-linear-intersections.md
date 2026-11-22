# Exact intersections during linear pattern edits

Changing the spacing on a row of overlapping cylinders invalidates every previous pair of operands. On a 25-copy row, keypad input to the matching exact preview fell from 296.8 to 125.1 ms (2.37×). On the 13-copy row it fell from 176.6 to 94.2 ms (1.88×). Each figure is the median across five new spacings in six fresh sessions per build.

The live kernel determines whether the first pair overlaps. Other workers intersect small serialized pairs while that kernel fuses the row. The live build checks the exact operand bytes again before it uses a measurement. A cold, refused or unavailable worker leaves the original measurement path available. Pools are scoped to an adapter and released after 15 idle seconds, a project switch or disposal.

## Matched browser measurements

The historical app was `1ccd730415f89742c3665d91aae7661912fc8505`. The direct comparator was the count-edit and closure change in `a0ebedfbf4b8ae58bc98dd5eafd78a05cac9ce9b`. The direct comparator and worker build both used their pinned Remus core and IO artifacts. Each block used fresh Chromium 156 sessions with an RTX 3090 on Linux. All six orderings of the three builds were used. The clock starts at the input event and stops when Done is enabled for that request.

| Copies | New spacing (mm) | Historical (ms) | Count-edit build (ms) | Worker build (ms) | Historical speedup |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 13 | 7 | 191.9 | 164.7 | 100.1 | 1.92× |
| 13 | 6.25 | 174.6 | 158.6 | 90.9 | 1.92× |
| 13 | 6.5 | 168.4 | 154.2 | 93.1 | 1.81× |
| 13 | 6.75 | 175.0 | 152.3 | 87.7 | 1.995× |
| 13 | 7.25 | 193.0 | 166.3 | 104.4 | 1.85× |
| 25 | 7 | 311.8 | 273.4 | 141.7 | 2.20× |
| 25 | 6.25 | 275.9 | 249.6 | 121.5 | 2.27× |
| 25 | 6.5 | 277.3 | 247.7 | 119.1 | 2.33× |
| 25 | 6.75 | 296.8 | 259.0 | 117.1 | 2.54× |
| 25 | 7.25 | 306.6 | 274.4 | 145.3 | 2.11× |

In the 13-copy trial, the first count edit (3 to 11) took 137.4 ms with the workers, 120.9 ms on the count-edit build and 150.9 ms historically. The first three-copy spacing change took 195.0, 192.6 and 199.7 ms respectively. Pool warm-up begins on the first positive exact pair. In the 25-copy trial, increasing from 12 to 25 took 96.4 ms against 164.0 ms on the count-edit build.

## Reproduction

Open a millimetre document with one unmodified cylinder, radius 5 mm and height 10 mm. Start a linear pattern, set spacing to 6 mm, then change count to 11, 12 and the final count. Set spacings to 7, 6.25, 6.5, 6.75 and 7.25 mm in order. The opt-in Playwright probe performs this sequence. With a performance build served as described in [Browser test suites](../browser-test-suites.md), run the following for each build. Use a separate output file for each revision and copy count.

```bash
OZ_PERF=1 OZ_PERF_ANGLE=gl OZ_PERF_LINEAR_COPIES=13 pnpm exec playwright test perf-pattern-preview --workers=1
OZ_PERF=1 OZ_PERF_ANGLE=gl OZ_PERF_LINEAR_COPIES=25 pnpm exec playwright test perf-pattern-preview --workers=1
```

## Correctness checks

The ten accepted preview frames per session matched the historical meshes, body volumes and warnings. A separate 28-document comparison through the browser geometry worker matched complete body representations, warnings and STEP exports with header timestamps normalized. The fixtures included box and cylinder rows, touching or disjoint stocks, shallow overlaps, skipped copies, negative and diagonal directions, grids and partial circles. Repeating the corpus with auxiliary workers that refused work or stopped replying produced the same results.

## Individual samples

All times are milliseconds in block order.

| Copies | New spacing (mm) | Historical | Count-edit build | Worker build |
| ---: | ---: | --- | --- | --- |
| 13 | 7 | 194.0, 194.2, 191.9, 191.9, 190.2, 186.0 | 167.2, 167.8, 162.5, 159.6, 165.1, 164.3 | 97.0, 94.5, 101.6, 103.9, 98.7, 105.3 |
| 13 | 6.25 | 174.3, 179.0, 174.2, 174.7, 174.5, 178.6 | 150.6, 163.0, 160.8, 160.3, 156.4, 156.8 | 93.6, 89.2, 100.8, 84.9, 92.6, 85.2 |
| 13 | 6.5 | 168.5, 168.3, 169.1, 167.4, 169.1, 167.9 | 153.9, 150.0, 155.3, 157.8, 153.7, 154.6 | 92.5, 93.8, 94.3, 101.2, 91.5, 88.5 |
| 13 | 6.75 | 177.3, 175.5, 167.9, 168.9, 176.0, 174.5 | 149.7, 153.9, 156.9, 152.2, 152.2, 152.5 | 86.1, 89.1, 92.2, 86.3, 86.1, 94.0 |
| 13 | 7.25 | 207.8, 191.0, 191.0, 190.7, 195.0, 207.8 | 167.3, 165.5, 166.2, 175.2, 166.0, 166.3 | 100.9, 105.5, 105.8, 106.2, 103.4, 99.2 |
| 25 | 7 | 309.2, 309.1, 322.7, 322.8, 314.0, 309.6 | 263.9, 278.2, 274.5, 273.2, 272.4, 273.6 | 142.1, 141.3, 135.0, 140.4, 148.9, 147.6 |
| 25 | 6.25 | 276.4, 276.2, 275.6, 275.1, 274.9, 277.7 | 249.6, 248.7, 246.8, 260.4, 250.3, 249.5 | 112.9, 117.2, 126.5, 122.5, 125.4, 120.5 |
| 25 | 6.5 | 272.9, 278.5, 273.8, 276.9, 281.6, 277.7 | 244.0, 248.2, 248.2, 243.9, 247.8, 247.5 | 122.9, 124.9, 115.3, 111.3, 118.1, 120.0 |
| 25 | 6.75 | 291.9, 292.9, 305.9, 295.9, 297.7, 298.0 | 260.5, 262.3, 258.0, 260.0, 257.7, 257.3 | 120.4, 116.9, 134.7, 117.2, 113.1, 113.6 |
| 25 | 7.25 | 307.0, 298.9, 306.8, 306.5, 308.3, 306.4 | 275.2, 277.0, 273.5, 271.9, 291.0, 273.4 | 153.1, 144.4, 139.0, 143.3, 153.2, 146.2 |
