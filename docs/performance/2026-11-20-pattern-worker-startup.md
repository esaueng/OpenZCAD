# First count edit on an overlapping cylinder row

A browser trace of the first count increase found eight exact intersections on the geometry worker taking 64 ms while its helper workers were still starting. Passing the compiled core WebAssembly module to the helpers lets each instantiate its own kernel and memory. Chrome's worker message queue still carries the exact operands and returns their measured volumes.

## Accepted exact preview

The endpoint was the time from the CAD keypad input event to acceptance of its matching exact frame in desktop Chromium with hardware OpenGL. Each session opened the same single-cylinder document, created a linear pattern, set spacing to 6 mm and increased the count from 3 to 11. Later edits grew the row to either 13 or 25 copies. Six fresh sessions per build and sequence used all six orderings of the three builds. There were no competing builds reported by the probe. Values are medians in milliseconds.

| Operation | Historical | Previous worker startup | Shared compiled module |
| --- | ---: | ---: | ---: |
| First count from 3 to 11, sequence ending at 13 | 152.85 | 155.55 | 74.30 |
| First count from 3 to 11, sequence ending at 25 | 149.35 | 154.75 | 75.10 |
| Count from 11 to 12, sequence ending at 13 | 138.70 | 71.85 | 82.70 |
| Count from 11 to 12, sequence ending at 25 | 139.50 | 70.65 | 75.70 |
| Five spacing edits at 13 copies | 180.05 | 84.05 | 82.10 |
| Five spacing edits at 25 copies | 301.30 | 112.95 | 107.95 |

Across the twelve sessions per build, the median first count edit fell from 149.95 to 74.45 ms (2.01×). The two groups separately measured 2.06× and 1.99×. The following 11-to-12 edit was slower than the previous worker implementation in both groups. Initial spacing on the three-copy pattern also remains below the 2× target.

Each of the 360 measured frames matched the corresponding baseline mesh positions, triangle indices, body volumes and warnings. A separate 28-document worker corpus checked full body representations, warnings and normalized STEP output, including refused and unresponsive helper jobs.

## Reproduction

Use the [linear pattern benchmark](2026-11-20-parallel-linear-intersections.md#reproduction) with both copy counts. Record the first count-11 step separately from the five spacing edits. The historical app was `1ccd730415f89742c3665d91aae7661912fc8505`. The previous-worker app was `c7d96868e5e141272bef83e2c606e28b4997ccc9`. Both modern builds used the identical core and IO package pair from the [strict unification comparison](2026-11-20-strict-pattern-unification.md). The core SHA-256 was `60eb3867a09be351a0a421120f01651ca7fabed88acf11d0ae632a5df544e93d`. The measurements preceded the receiver-side clone-failure fallback and restriction of module messages to worker warm-up.
