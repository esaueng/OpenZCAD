---
row: W05
state: Partial
---

Status correction (2026-11-22 ledger review): Revalidate → Partial. The findings were reproduced and fixes merged: "dimension graphics reuse their fat-line GPU buffers" (2026-10-14), and "per-drag layout fell from 1.6–3.5 s to 0.10–0.19 s" ([face-commit hitches](docs/qa/2026-11-11/face-commit-hitches.md)). Remaining: the two-commit R2 filleted-union case still has 44–114 ms post-release tasks from command-rail and callout reflow. Frame-rate, p99 and hitch gains are unproven on a deployed device.
