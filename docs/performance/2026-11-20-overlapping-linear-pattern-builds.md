# Overlapping linear pattern builds

Increasing the count of a linear pattern used to intersect every neighbouring pair of solids again, including pairs whose placements had stayed identical. The adapter now checks the serialized operands for equality before reusing a successful intersection volume. It checks stock complexity before serializing and retains at most 32 pairs of 8 KiB per kernel. A different spacing changes the operands and triggers exact intersections.

Both count and spacing edits also spend time checking whether the fused mesh is closed. Numeric maps index occupied weld cells by axis so a lookup can skip an empty plane or column. The centre cell still takes precedence, and occupied neighbours are searched in the original order with the same tolerance.

## Reproduce the browser workload

Open a millimetre document containing a single cylinder with a 5 mm radius and 10 mm height. Start a linear pattern along X. Using the keypad, set spacing to 6 mm, set count to 11, then 12, then 13. Leave the count at 13 and enter each spacing in the order below. For keypad edits the clock starts on the input event and stops when Done becomes enabled for the matching exact preview. This measures interactive preview latency.

Six fresh Chromium sessions per build ran the same schema-113 document on an RTX 3090 with ANGLE OpenGL. The run rotated build order. The historical release was `1ccd73041`. The intersection-only build and combined build used parent `5b6749b22`. All three used identical core and translator WASM binaries. Functional tests also ran on the host. Values below are medians in milliseconds. Ratios use unrounded samples.

| Edit                   | Historical | Intersection reuse only | Both changes | Historical / combined |
| ---------------------- | ---------: | ----------------------: | -----------: | --------------------: |
| Open preview           |       62.0 |                    61.7 |         60.7 |                 1.02× |
| Set spacing to 6 mm    |      210.5 |                   213.4 |        205.9 |                 1.02× |
| Set count to 11        |      156.1 |                   146.2 |        125.1 |                 1.25× |
| 11 → 12 copies         |      146.2 |                    84.9 |         67.4 |                 2.17× |
| 12 → 13 copies         |      147.5 |                    83.7 |         57.8 |                 2.55× |
| Spacing 6 → 7 mm       |      197.4 |                   204.8 |        166.2 |                 1.19× |
| Spacing 7 → 6.25 mm    |      188.4 |                   190.1 |        161.2 |                 1.17× |
| Spacing 6.25 → 6.5 mm  |      176.3 |                   178.7 |        161.2 |                 1.09× |
| Spacing 6.5 → 6.75 mm  |      180.6 |                   189.2 |        160.9 |                 1.12× |
| Spacing 6.75 → 7.25 mm |      199.4 |                   198.1 |        175.0 |                 1.14× |

## Geometry and attribution

Across nine count and spacing configurations, the combined build matched the historical mesh bytes, volume, face and edge counts, and warnings. Each incremental count edit needed only one new pair intersection. Changing spacing on the 13-copy pattern still required all 12.

On four captured pattern meshes, eight alternating pairs measured closure checking alone at 5.8 → 0.9, 11.2 → 1.8, 11.8 → 2.1 and 17.6 → 2.7 ms. The adapter regression compares edited pattern results with a fresh build, exercises cache refusal and checks that complex stock skips serialization. Two closure tests distinguish valid weld representatives through their resulting winding counts. See [pattern overlap reuse](../../test/linear-overlap-reuse.test.ts) and [mesh closure](../../test/display-mesh-closure.test.ts).

## Individual browser samples

Times are milliseconds, rounded to one decimal place, in session order within each build.

| Edit                   | Historical                               | Intersection reuse only                  | Both changes                             |
| ---------------------- | ---------------------------------------- | ---------------------------------------- | ---------------------------------------- |
| 11 → 12 copies         | 149.8, 144.8, 136.6, 144.5, 147.5, 147.8 | 100.8, 84.9, 84.9, 80.8, 89.0, 73.1      | 64.5, 68.4, 66.4, 62.2, 68.4, 81.5       |
| 12 → 13 copies         | 153.3, 145.0, 138.5, 149.5, 146.2, 148.9 | 80.3, 86.2, 81.0, 83.5, 83.9, 84.6       | 61.6, 57.1, 54.2, 57.8, 60.7, 57.7       |
| Spacing 6 → 7 mm       | 205.5, 194.4, 190.9, 208.3, 196.8, 197.9 | 245.0, 195.9, 204.4, 197.0, 210.7, 205.2 | 163.4, 164.2, 167.4, 175.9, 165.0, 168.4 |
| Spacing 7 → 6.25 mm    | 190.8, 187.7, 189.9, 188.6, 187.4, 188.3 | 194.7, 187.0, 188.5, 191.5, 191.4, 188.7 | 163.3, 167.6, 157.3, 155.3, 166.3, 159.2 |
| Spacing 6.25 → 6.5 mm  | 184.2, 175.5, 170.3, 177.9, 177.2, 175.5 | 187.1, 173.2, 176.9, 171.3, 187.4, 180.5 | 159.4, 161.0, 161.8, 161.3, 166.5, 161.1 |
| Spacing 6.5 → 6.75 mm  | 180.9, 187.4, 175.7, 180.3, 180.0, 180.8 | 198.9, 187.8, 190.6, 177.8, 192.8, 184.1 | 161.2, 160.6, 163.6, 162.4, 160.1, 156.6 |
| Spacing 6.75 → 7.25 mm | 208.0, 194.4, 210.2, 194.9, 202.5, 196.4 | 202.9, 190.3, 205.8, 193.3, 206.9, 192.9 | 174.7, 174.3, 170.4, 175.8, 175.2, 184.0 |
