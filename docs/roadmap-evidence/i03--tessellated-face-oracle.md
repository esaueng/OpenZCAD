---
row: I03
---
Stored-unit conversion now accepts variable fillets, including per-corner radii (v151), in both mm→in and mm→cm. Oracle 2 had refused them because the kernel measures B-spline face area by tessellating at a fixed 0.08 model-unit deflection. The shape is the same across units (sampled points agree within 2e-14 mm, volume to 1e-15), so those faces are now matched by sampled surface points instead of area (`test/units-reference-recapture.test.ts`). The NURBS import still refuses on volume (`test/parity/unit-conversion.spec.ts`).
