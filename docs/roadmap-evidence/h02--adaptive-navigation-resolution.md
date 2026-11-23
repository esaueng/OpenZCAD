---
row: H02
---

Adaptive resolution during slow orbit and pan, including buttonless trackpad pan.
Two consecutive slow moving frames can lower the backing ratio to 1.25× or
0.75×. A still frame restores full detail, and image export retains its normal
dimensions and styling throughout. The browser regression exercises a slow
trackpad pan and opens Export Image while the canvas is reduced. In two
Chromium SwiftShader runs on the 88-bore tooling plate at 1366 × 1024 CSS
pixels and 2× display density, median intervals between changed camera draws
fell from 354–359 to 158–159 ms in orbit and from 338–340 to 155–158 ms in
pan. Across whole gestures, including initial full-size draws, orbit rose
from 2.9–3.0 to 3.9–4.5 changed draws/s and pan from 3.4–3.8 to 5.2–5.4.
[Tooling plate fixture](https://github.com/esaueng/remus/blob/d4f588f3a68df33e1f9203c3dec50af0adfa2cb4/scripts/perf/tooling-plate/dense.openzcad).
