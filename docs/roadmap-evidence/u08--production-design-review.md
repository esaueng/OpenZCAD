---
row: U08
---

Panel suspension receives the effective workspace mode after seat and project permissions resolve the stored preference. Stale feature/sketch editing state cannot suspend panels in View, Tweak or Draw. Three hook regressions fail against the preceding implementation and pass with this guard; Build-mode suspension and explicit-release controls remain covered. The browser viewer journey verifies that effective View mode keeps modeling unavailable.

History details suspend panels only while a primitive form or the selected feature's actual in-place editor is open. Read-only imported/direct-edit rows and failed editor arming keep panels visible. The imported-mesh browser regression reproduces hidden History before the fix; active primitive/Hole editing remains covered by the same production-renderer suite.

Sketch plane selection and the entered sketch share one suspension identity. A browser regression reopens History at the plane prompt, keeps it visible after choosing the plane, then verifies a new sketch session suspends it again.

Production design review (PR #890): feature forms suspend model panels and the extra-tools fold while preserving the saved layout and camera. Explicit panel requests override suspension for their editing session; direct switches between sketch or feature sessions reset the release. Header controls own their full 24px hit rectangles in both themes (`usePanelSuspension.test.tsx`, `design-review-fixes.spec.ts`, `panel-dock.spec.ts`).
