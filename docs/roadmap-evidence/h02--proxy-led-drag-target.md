---
row: H02
---

Face-drag targets settled (owner decision 2026-11-21): H02's 60 fps, first-geometry ≤ 100 ms and p95 ≤ 50 ms targets apply to what follows the pointer, and proxy-led dragging meets them on the RX 6600 (proxy frames 15–16 ms p95; 119–122 frames in a 2 s drag, 17.2–18.2 ms p95, #1834). First exact geometry, built once the hand rests, stays a measured and budgeted row (2.3–2.7 s from the first move; kernel time 61–404 ms), and an exact preview fast enough to stream while the pointer moves, including the complex-fillet case's 385–404 ms exact build, is split out as [K11](ROADMAP.md#k11) ([record](docs/performance/2026-11-20-drag-orbit-sustained-baselines.md); `scripts/active1-budgets.mjs`).
