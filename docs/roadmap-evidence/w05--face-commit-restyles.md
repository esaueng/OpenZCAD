---
row: W05
---

Face-resize drags and commits stopped restyling the whole workspace on each frame. Chip and HUD text now updates in place (`lib/domText.ts`) instead of through child-list mutations that re-ran the stage's `:has()` rules. The placeholder `:has()` rule became a lane class. The history timeline measures before it writes and places from its ResizeObserver report. Live section caps scan buffers directly. On a contended local host, per-drag layout fell from 1.6–3.5 s to 0.10–0.19 s. The probe's two-commit R2 filleted-union case still shows post-release tasks of 44–114 ms from command-rail and callout reflow. Measurements, root causes and remaining work are in [face-commit hitches](docs/qa/2026-11-11/face-commit-hitches.md). This is not a deployed-device frame-rate guarantee.
