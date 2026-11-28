---
row: K10
---

Every feature that works on a body it does not make (Transform, Shell, Draft,
Hole, Split, Pattern, fillet, chamfer, Thicken, Rib, Wrap, boolean operands,
through-all and up-to-next cuts, Thread, Gear, custom features) now refuses a
missing target body with the adapter's typed `target_body_unavailable`
(`reference`/`invalid_input`) and a translated sentence on the bar, History and
Resume (`target-body-unavailable.test.ts`, `kernel-adapter.test.ts`). Split's
touch sentence names a single-point contact (R10 r3 torus at x = 13,
`cad-workflow-coupon.test.ts` S8), and its "not planar" sentence no longer
says curved faces cannot be cut. History and Resume put the document's length
unit after a refused fillet's or chamfer's sizes, as the bar does
(`test/e2e/blend-refusal-units.spec.ts`, mm and inch).
