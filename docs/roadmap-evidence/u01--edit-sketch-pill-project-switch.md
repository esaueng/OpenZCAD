---
row: U01
---

Correction (2026-11-12): the UX-5 Edit Sketch pill follow-up is fixed. #1001
(`5f4d3e9c`) clears the pill in a layout effect keyed on the project id, so
it never paints in the next project (`apps/web/src/App.tsx`, "Nor does it
outlive its project"); it no longer belongs in this row's remaining work.
