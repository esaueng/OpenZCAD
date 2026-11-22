# Moving a hole in a 100-hole point pattern

Moving the last hole used to rebuild all 99 pattern cuts. An instrumented edit spent 394 ms checking intermediate volumes and about 4.5 ms assigning face names. The builder now retains the exact solid three cuts before the end of an eligible pattern. Moving the last point reruns three cuts. Removing the last three copies in succession reruns two, one and zero cuts.

## Time from Apply to the changed plate

These are medians of six fresh Chromium sessions per build on an RTX 3090. All six build orders were used, with identical Remus core and translator binaries. Each session moved the last sketch point by 0.25 mm.

| Time from Apply | Original `1ccd730415` | Parent with shared bore checks | With checked cuts |
| --- | ---: | ---: | ---: |
| Committed exact analysis ready | 1,152.35 ms | 697.60 ms | 269.30 ms |
| First frame showing the changed plate | 1,293.40 ms | 838.05 ms | 411.55 ms |

The first changed frame arrived **3.14× faster than the original and 2.04× faster than the parent**. Each sample required a worker reply containing the bore at its new coordinate, a committed revision with exact analysis, an installation that changed the rendered model, and that revision’s frame. Mesh hashes, triangle counts, volume and warnings agreed on all three builds. The complete projected topology also matched between the parent and candidate.

## Where reuse helps

Six fresh adapter processes per build ran a sequence growing the same plate to 32, 64 and 100 holes, then moving the last point. The table gives median exact rebuild time. These measurements exclude installation and drawing.

| Operation | Original | Direct parent `49cbdbe403` | With checked cuts |
| --- | ---: | ---: | ---: |
| Build 32 holes | 250.71 ms | 166.19 ms | 167.44 ms |
| Grow to 64 | 661.85 ms | 408.47 ms | 400.45 ms |
| Grow to 100 | 1,080.34 ms | 541.02 ms | 492.91 ms |
| Move last point | 1,199.39 ms | 704.29 ms | 251.09 ms |

A separate six-run comparison moved the first copy, a middle copy and the last copy in sequence. The first edit took 660.6 ms on the parent and 664.7 ms with reuse. The middle edit took 661.5 and 657.2 ms. Both changed the saved operands and caused a full replay. The last edit took 652.3 and 259.9 ms. A fresh 100-hole build in this comparison took 804.3 and 815.6 ms. Complete fixed-header STEP files matched the parent at all four stages of the growth and edit sequence.

The smaller prototype (32-copy limit, 128 KiB budget) was also measured on three successive tail skips over six browser sessions per size and build. Median click-to-changed-frame times for the 32-hole plate were 197.05 ms originally, 132.15 ms with shared bore checks, and 110.90 ms with cut reuse. At 12 holes the same times were 55.70, 52.05 and 52.45 ms. Both remain below the 2× workflow goal.

## Reproduce the edit

Make a 100 × 100 × 10 mm plate with its minimum corner at the origin. Drill a 6 mm diameter through-hole at (10, 50) mm. On its top plane, put the reference point at the bore centre. Add 99 points in row order on a 10 mm grid starting at (5, 5), advancing x first, with the last point at (85, 95). Use Point pattern in Features mode to repeat the hole at the points. In History, edit the locations sketch, change the last point’s x coordinate to 85.25 mm and select Apply. Run the integration fixture and its cold-adapter geometry comparison with the following command.

```sh
pnpm exec vitest run test/point-pattern.test.ts
```

Reuse requires a single simple untapped hole, single cutters, eligible stock with at most eight planar or cylindrical faces, the same project and target volume, and byte-identical stock and ordered prefix cutters. Full validation and naming run on the resulting solid. The cache stores one checked result per kernel and clears on project change. The budget is 384 KiB for operands and solid together. This plate used 331,008 bytes. A larger entry or a changed prefix falls back to serial cuts. Another eligible pattern can replace the cached result.

On the integrated parent `e7ec890fc`, the point-pattern and tapped-hole suites passed all 30 tests. Fresh adapters on the integrated parent and candidate also produced identical full projected topology, mesh, bore locations and volume at each step of the four-state growth sequence and the four-state first/middle/last edit sequence.
