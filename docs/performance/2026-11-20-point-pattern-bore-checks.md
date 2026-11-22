# Exact bore checks on a sketch-point pattern

A 32-hole plate edit spent time measuring the same finished solid once per retained hole. Reading its cylindrical faces once reduces that work while retaining each bore’s axis and radius check. A tapped copy is still checked on the plain solid before threading. Later checks read the current solid.

## Browser results

Median milliseconds from clicking a copy to the first model frame drawn with the matching checked triangle count. Each build ran six fresh Chromium sessions per size, three distinct edits per session. The order of the three builds rotated through all six permutations. The machine used hardware OpenGL on an RTX 3090. Other short diagnostic jobs overlapped part of the run.

| Starting holes | Historical | Direct parent | Shared face scan | Historical speedup |
| ---: | ---: | ---: | ---: | ---: |
| 12 | 55.8 | 55.6 | 52.2 | 1.07× |
| 32 | 201.0 | 194.1 | 135.7 | 1.48× |

The original build was `1ccd730415` and the parent was `46c6b4dbaa`. The candidate used the same Remus core and translator binaries. All six session medians improved against the direct parent at each size. Across the 108 edits, the matching worker replies agreed on volumes, mesh vertex and index digests, and diagnostics. The expected plate volume after skipping a copy is 40,000 − (90π × remaining holes), in mm³.

In a separate adapter run, moving the last of 32 points reduced the number of edge samples from 2,048 to 128. Median exact rebuild time across six uninstrumented fresh processes went from 159.5 ms on the historical build and 163.0 ms on the parent to 100.0 ms. Full projected topology, bore coordinates, volume and mesh agreed between the parent and the candidate. The 2× workflow target remains open.

## Reproducing the workflow

Build a 100 × 40 × 10 mm box with its minimum corner at the origin. Drill a 6 mm diameter through-hole at (10,20) on the top face. Create a sketch on XY at z = 10 mm with the following points in pick order, measured in mm.

```text
(10,20) (40,10) (70,30) (90,20) (20,10) (55,20)
(80,10) (30,30) (60,30) (12,30) (48,30) (90,30)
(6,4.5) (6,12) (6,34.5) (13.5,4.5) (13.5,12) (21,19.5)
(21,27) (21,34.5) (28.5,4.5) (28.5,12) (28.5,19.5) (36,4.5)
(36,19.5) (36,34.5) (43.5,19.5) (51,4.5) (51,12) (58.5,4.5)
(58.5,12) (66,4.5)
```

Use Point pattern in Features mode to repeat the hole. Select either the first 12 points or all 32, using the first point for the original, and finish the feature. Reopen the pattern from History in Build mode. Click each of the last three numbered copy chips in reverse pick order to skip it. Wait for the matching exact frame after each click. Use a fresh project for each session with the same fixture on all builds.

For an instrumented comparison, start the clock at the chip’s click. Match the checked worker reply by request ID, then stop at the first `openzcad:e2e-camera-frame` on which the viewport’s `data-e2e-rendered-triangles` matches the new single visible mesh. A full-render E2E build exposes these signals. On this fixture each edit changes the triangle count. The Done button enabled earlier and was recorded separately.

The point-pattern and tapped-hole regression suites exercise the adapter and the pre-thread checks.

```sh
pnpm exec vitest run test/point-pattern.test.ts test/tapped-holes.test.ts
```
