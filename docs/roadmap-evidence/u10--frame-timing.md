---
row: U10
---

iPad-class frame timing measured by proxy, not on a device
(`perf-frame-timing.spec.ts`, `OZ_PERF=1`: desktop Chromium, 1366 × 1024 touch
viewport at device pixel ratio 2, CDP CPU throttling ×1/×4/×6, Intel
integrated GPU). The studio material and environment cost nothing measurable.
The curved-surface outlines add 1–8 ms of GPU p95 per frame at ×1 and up to
9× the triangles drawn, and their candidate build stalls each curved body
build for 22–320 ms (0.2–1.5 s at ×4–×6). The touch render budget absorbs
most of the per-frame cost after the first gesture. Results and real-iPad
instructions are in the plan's follow-up.
