---
row: K05
---

2026-11-05 source-first routing across one boolean (kernel robustness plan WS4, after #1252). More face drags on a union or subtract result now edit the consumed operand's stored value and replay, rather than moving the boolean's face. Each crossing uses the cylinder-radius contract, factored into `booleanOperandSource`:

- The v5 role must be current and published in the walked chain, and the operand must be consumed.
- Intersects, kept or copied sources, and an earlier local move of the same value stop it.
- So does a fillet or chamfer that holds a hash-only edge pick.

Covered drags:

- **Cylinder and cone caps** (`boolean.face.operand.N.primitive.(cylinder|cone).face.cap.*`) drive the primitive height. A subtract tool's cap faces back out of the cut, so pulling a bore's floor outward shortens the tool.
- **Box max sides across a subtract** drive the target box's dimension after a fillet or chamfer. This applies only when every face around the side traces to the target (a side the tool bites into stays local).
- **A new-body extrude's far cap** (`boolean.face.operand.N.sweep.face.cap.end…`) drives its distance across a union or subtract. Add/cut extrudes and scaled operands are refused.
- **Sphere patches, cone walls and torus shells** resolve selection ownership to their primitive directly or across the boolean. There is no curved-face drag handle for them yet.

Evidence:

- `test/source-first-routing-across-boolean.test.ts`: real kernel, closed-form volume and face-position oracles, closed mesh, STEP export.
- Guard units in `cylinderPrimitiveAncestry.test.ts` and `extrudeCapAncestry.test.ts`.

Remaining:

- A sphere/cone/torus radial handle.
- Cone walls lose their role across a boolean.
- Box min sides and tool sides still stay local.
