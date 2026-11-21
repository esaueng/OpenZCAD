# Exact display meshes for point-pattern edits

On a plate with 24 or more picked points and at least 20 active copies, the geometry worker can tessellate the finished patterned solid while the rebuild checks its bores and face names. It limits this to a visible terminal pattern of one simple untapped through-hole on rectangular stock. Measurement accepts the result only for the same solid handle and the same display deflections. For meshes of at most 20,000 triangles the viewport can also prepare shading before the full reply arrives. Larger replacements already use a separate display worker.

## Browser results

Median time from clicking Skip on a copy to the first frame showing the matching exact mesh. The original OpenZCAD revision was `1ccd730415`, the direct parent was `6a4690dfb`, and the candidate was `5abe2790e`. Parent and candidate used the same released Remus core and translator binaries at `c81a719a`.

| Holes | Original (ms) | Parent (ms) | Candidate (ms) | Speedup vs original | Speedup vs parent |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 12 | — | 52.5 | 52.7 | — | 1.00× |
| 16 | — | 60.8 | 58.1 | — | 1.05× |
| 24 | 130.4 | 99.7 | 78.8 | 1.65× | 1.27× |
| 32 | 199.0 | 134.3 | 109.9 | 1.81× | 1.22× |
| 64 | — | 252.4 | 235.0 | — | 1.07× |
| 100 | — | 720.4 | 694.8 | — | 1.04× |

Each fresh Chromium session on an RTX 3090 applied three different skips. The 24- and 32-hole fixtures used all six orderings of original, parent and candidate. The other four sizes used four alternating pairs against the parent. A dash marks a size without a historical arm in this comparison.

| Holes | First skip (ms) | Cold opening (ms) | Geometry worker round trip (ms) | Reply to frame (ms) | Faster paired sessions |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 12 | 58.9 → 61.9 | 505.8 → 501.2 | 25.9 → 25.9 | 20.6 → 21.7 | 3/4 |
| 16 | 78.8 → 79.8 | 654.4 → 653.1 | 33.6 → 32.0 | 19.5 → 19.0 | 3/4 |
| 24 | 102.9 → 99.1 | 729.3 → 737.3 | 53.6 → 50.3 | 33.8 → 20.8 | 6/6 |
| 32 | 145.9 → 126.6 | 790.9 → 790.0 | 82.0 → 76.6 | 42.1 → 24.9 | 6/6 |
| 64 | 461.4 → 459.5 | 1037.3 → 1053.6 | 181.0 → 166.0 | 66.5 → 60.3 | 4/4 |
| 100 | 811.6 → 786.8 | 1383.0 → 1400.3 | 630.1 → 610.9 | 75.9 → 74.0 | 4/4 |

The second table shows parent → candidate. The session count compares each session's median of three skips. Phase medians are calculated separately.

On the 32-hole plate the largest reduction was between receiving the worker reply and drawing the matching frame, from 42.1 to 24.9 ms. Its 2× target is 99.5 ms from click to frame. The measured median was still 10.4 ms above that target. Cold opening on the 24-, 64- and 100-hole fixtures took 8–17 ms longer in this sample.

## Reproducing the edit

For 12, 16, 24 and 32 holes, use the first corresponding number of sketch points in the existing point-pattern fixture. For 64 and 100 holes, use a 100 × 100 × 10 mm plate. Put the original Ø6 mm through-hole at (10, 50) on the top face. Starting at (5, 5), add sketch points every 10 mm in X through 95 mm, then advance Y by 10 mm. Use the first 63 or 99 grid points after the reference point. [Small-plate coordinates and frame instrumentation](2026-11-20-point-pattern-bore-checks.md)

Open the pattern in History and skip its last three copies, one at a time, in reverse pick order. Match each preview request ID to its checked worker reply and the first viewport frame whose triangle count matches that reply. The active solid changes triangle count every time. Check its expected volume against stock volume minus 90π mm³ per remaining hole. Across builds, compare mesh vertex and index digests, volumes and warnings. Between the direct parent and candidate also compare the full topology and body metadata, including the opening result.

A separate Chromium run collected precise branch coverage on the renderer built from the candidate commit. The branch returning the staged geometry ran once on opening and once on each of the three skips at both 24 and 32 holes. At 12 holes it returned no staged meshes. The 64- and 100-hole plates took the dense display path. These coverage runs are excluded from the timing table.

Three additional parent/candidate replays used the first copy, the middle copy and the last copy on 24-, 32- and 100-hole plates. Each replay mixed skips and restorations across six edits. All 18 states matched the direct parent in full topology, meshes, volume and warnings. Restoring the last copy returned the opening vertex and index bytes.

A separate 32-hole replay withheld the helper module or served one that never replied. In both fault cases the opening and three edits used the live kernel, retained the reference geometry and warnings, and attempted helper startup once. A superseding edit has regression coverage for releasing its wait before the helper times out. The viewport consumes staged geometry only when the vertex bytes, index bytes and face ranges match.
