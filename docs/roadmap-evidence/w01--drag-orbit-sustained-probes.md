---
row: W01
---

The Active 1 script gains `face-drag`, `orbit` and `sustained` probes with budgets (`scripts/active1-budgets.mjs`): interaction during a face drag stays inside the 100 ms screen target on the RX 6600 (pointer → frame 15–16 ms p95, frames 16.7 ms median), orbit holds 60 fps with no dropped refreshes at ×1 and ×4 CPU, and 300 edits through the worker's adapter keep WASM memory at a 102 MB plateau with flat heap and edit times ([record](docs/performance/2026-11-20-drag-orbit-sustained-baselines.md)). Integrated-GPU and target-device budgets remain owner-pending, with ready commands in the record.
