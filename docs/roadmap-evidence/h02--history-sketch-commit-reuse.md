---
row: H02
---

History sketch dimension edits can commit their checked exact geometry. On a plate with a downstream Boolean through-cut and 30 independent boxes, the 22, 23 and 24 mm width edits fell from 155.8 to 34.6 ms (4.50×), 113.0 to 33.3 ms (3.39×), 101.4 to 26.8 ms (3.78×), respectively (three browser runs per revision). Each edit sent one worker sync instead of two and produced the expected 864, 904 or 944 mm³. The [paired Chromium benchmark](docs/performance/2026-11-20-history-sketch-reuse.md) times Apply to the committed exact-analysis event.
