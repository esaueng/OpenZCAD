---
row: U01
---

Hole and cylinder selection help, action labels and value-kind metadata now
follow the control's displayed quantity: diameter by default, radius when
explicitly selected with the existing Ø/R toggle. The operation card and
workspace instructions read the same display mode as the viewport and exact
entry. Geometry values and fillet/sketch radius wording are unchanged.
Regression coverage: `interaction/prompt.test.ts`, `interaction/machine.test.ts`,
`interaction/capabilities.test.ts`, and the diameter/radius toggle in
`test/e2e/through-hole-chamfer-resize.spec.ts`.
