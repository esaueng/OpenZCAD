---
row: U02
---

Production design review (PR #890): Hole creation offers exact numeric entry on the current in-place draft before commit, retaining face/position/style and the current command. This integrates with U09's keypads and Options rather than restoring its retired form cards. Editable inspector forms and active in-place edits label committed measurements as last applied; read-only imported-feature details keep current-measurement labels. In-place empty-cut refusals offer recovery and expandable technical details. Repeated sketch names use consistent, collision-free labels in geometry lists, constraint rows and inspection targets (`InPlaceCommandBar.test.tsx`, `Inspector.test.tsx`, `objectLabels.test.ts`, `constraintInspection.test.ts`, `design-review-fixes.spec.ts`).
