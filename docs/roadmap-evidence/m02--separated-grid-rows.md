---
row: M02
---

Complete orthogonal grids of overlapping rectangular stock reuse one exact row
when a gap separates the rows. The browser medians for the 3×3, 10×3 and
10×10 Grid pattern previews on the ×50 bar fell from 655/2,324/6,977 ms to
573/871/1,427 ms. Three alternating pairs of full-render local builds used
Chromium 156, Ryzen 9 5900XT and RTX 3090 with the same Remus 2026.1.151 pin.
The 10×10 adapter produced 780 faces with zero warnings and zero replay on
Done. The nested-pattern regression compares published topology, mesh, STEP
and a downstream subtraction with the full fuse
(`test/grid-row-fusion.test.ts`). See the
[measurements](docs/performance/2026-11-20-grid-row-fusion.md).
