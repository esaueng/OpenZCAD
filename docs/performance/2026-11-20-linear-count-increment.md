# Adding one copy to an overlapping linear pattern

After increasing the count of an overlapping cylinder row, one new adjacent pair needed an exact intersection. The existing worker pool accepted batches of six or more, so the live geometry worker intersected this pair and then fused the row. A warm helper can intersect the pair while the live worker fuses. The helper receives serialized solids. Its result still has to pass the existing exact-quality and operand checks.

## Time to a matching exact preview

Six fresh desktop Chromium sessions per build ran each of two sequences on Linux with an RTX 3090. All six permutations of the three build orders were used. The clock started at keypad input and stopped when Done became enabled for that request. Each session patterned a single cylinder of radius 5 mm and height 10 mm, set the spacing to 6 mm, then changed the count to 11, 12 and either 13 or 25. The two groups had identical inputs through the change to 12.

| Edit and group | Original (ms) | Previous build (ms) | One-pair change (ms) |
| --- | ---: | ---: | ---: |
| 11 to 12, sequence ending at 13 | 136.90 | 74.60 | 71.75 |
| 11 to 12, sequence ending at 25 | 137.85 | 70.05 | 62.95 |
| 11 to 12, pooled median | 137.55 | 71.55 | 68.40 |
| 12 to 13 | 141.30 | 55.65 | 50.45 |
| 12 to 25 | 276.65 | 88.50 | 88.05 |

The 11-to-12 edit improved 1.05× over the previous build and 2.01× over the original. The two groups separately reached 1.91× and 2.19× over the original. The matched runs used the original application at `1ccd730415f89742c3665d91aae7661912fc8505` and the previous build at `06bff768047768ec99246327237399fee4c2d1ae`. The previous and changed builds used the same released Remus packages at `c81a719a9cd6eb4d75da562d2e7af14e7c5e54eb`.

All 360 measured frames matched for mesh positions, indices, body volumes and warnings. In a separate browser corpus, full bodies, warnings and normalized STEP matched the previous build on 28 documents in each of four worker modes covering normal operation, receiver-side module-clone failure, worker refusal and a missing reply. The adapter regression test compares a count edit with a serial edit starting from the same previous display, including its held tessellation deflection.

A separate Chromium worker replay edited the count from 12 to 13 with and without the second copy skipped. In both cases exactly one helper measured one pair. The edited body, warnings and normalized STEP matched the parent through normal operation, a failed module clone, an intersection refusal and a missing reply.

Opening the tool with its initial spacing took 55.70 and 62.45 ms in the two groups, compared with 51.15 and 57.45 ms on the previous build. That step produces no overlapping pair. Its timings are included to show variation outside the optimized path.
