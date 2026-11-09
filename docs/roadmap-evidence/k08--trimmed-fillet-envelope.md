---
row: K08
---

Fillet acceptance can certify a loose spline control-hull box using only the
affected faces at a finer chord tolerance. The source envelope tolerance,
volume-change guard and blend-band guard remain in force; missing bindings or
tessellation work limits refuse safely (`fillet-envelope.test.ts`). This fixes
an imported-part R1.5 false refusal without replacing its geometry. Full video
workflow qualification remains separate.
