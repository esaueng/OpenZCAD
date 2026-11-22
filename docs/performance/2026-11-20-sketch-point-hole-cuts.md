# Rebuilding a multi-position Hole after editing its sketch

Moving the last point of a 32-hole feature previously repeated all 32 checked cuts. The exact builder can now restore the solid after the first 31 cuts and perform the changed cut once. A match requires identical stock bytes and identical ordered cutting parameters in the same project and kernel. Face names are assigned for the current revision. This path handles simple untapped Hole features with 8–32 selected sketch points on rectangular stock and retains at most 128 KiB per kernel.

## Exact rebuild time

Median milliseconds for the same sequence of calls to `syncDocument`. Six fresh processes per build ran in alternating orders, covering all six permutations. All three builds used the same kernel packages.

| Operation | Historical `1ccd730415` | Parent `46c6b4dbaa` | Checked prefix | Parent cuts | New cuts |
| --- | ---: | ---: | ---: | ---: | ---: |
| First 12 points | 110.84 | 108.89 | 110.94 | 12 | 12 |
| Extend to 24 points | 204.83 | 200.33 | 197.10 | 24 | 13 |
| Extend to 32 points | 193.72 | 191.79 | 136.80 | 32 | 9 |
| Move the final point 0.25 mm | 155.09 | 159.99 | 60.45 | 32 | 1 |

The final point edit was 2.57× faster than the historical build and 2.65× faster than the parent. These times cover the exact adapter call through its returned projection. The browser also handles picking, scheduling and drawing. The first 12-point build has no previous solid to restore.

## Adding points in the browser

Reopen the Hole from History with its first 9 or 29 points selected. Pick each of the next three points on the plate, waiting for the matching frame before picking the next. A hardware Chromium session ran each sequence once per build, with six sessions per build and sequence. All six orders of historical, parent and candidate builds were represented. Timing began on the pointer-down event before the canvas handled the pick. The checked worker reply was identified by request ID. The displayed endpoint was the first viewport camera-frame event with its new triangle count. Every pick changed that count.

| Final holes | Endpoint | Historical (ms) | Parent (ms) | Checked prefix (ms) |
| ---: | --- | ---: | ---: | ---: |
| 12 | Done enabled | 47.50 | 48.55 | 38.05 |
| 12 | Corresponding frame | 62.95 | 63.95 | 54.50 |
| 32 | Done enabled | 152.15 | 150.80 | 74.30 |
| 32 | Corresponding frame | 184.70 | 182.60 | 112.15 |

Values are medians across 18 picks per build and size on an RTX 3090 with hardware OpenGL. Brief diagnostic jobs overlapped some sessions. All 108 picks returned the expected volume, identical mesh hashes for the corresponding build step, and empty diagnostics. Every candidate session median beat the paired parent session at both sizes. The 32-hole sequence reached 2.05× historically at Done and 1.65× at the matching frame. The 12-hole sequence reached 1.16× at the matching frame.

## Fixture and geometry checks

Use a 100 × 40 × 10 mm plate with its minimum corner at the origin and an XY sketch on its top face at z = 10 mm. Use the following sketch points in pick order, in mm.

```text
(10, 20) (40, 10) (70, 30) (90, 20) (20, 10) (55, 20)
(80, 10) (30, 30) (60, 30) (12, 30) (48, 30) (90, 30)
(6, 4.5) (6, 12) (6, 34.5) (13.5, 4.5) (13.5, 12) (21, 19.5)
(21, 27) (21, 34.5) (28.5, 4.5) (28.5, 12) (28.5, 19.5) (36, 4.5)
(36, 19.5) (36, 34.5) (43.5, 19.5) (51, 4.5) (51, 12) (58.5, 4.5)
(58.5, 12) (66, 4.5)
```
Place a single Hole feature on the top face, enable sketch-point positioning, and select the first 12 points. Use a simple 6 mm diameter through-hole. Extend the selection to 24 points, then 32. For the last edit, move the final sketch point from (66, 4.5) to (66.25, 4.5) mm.

The comparisons checked the locations of all bores, expected plate volume of (40,000 − 90π × bore count) mm³, mesh vertices, triangle indices, face and edge counts, and warnings. The complete projected topology also matched on the parent and candidate. The adapter regression covers the named bore faces, a coincident-point refusal, and changing the first point. A separate kernel test compares the complete serialized solid on append, deletion, changed stock and an unavailable saved solid.

```sh
pnpm exec vitest run test/hole-points.test.ts
```
