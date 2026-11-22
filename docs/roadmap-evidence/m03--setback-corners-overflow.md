---
row: M03
---

2026-11-22 setback corners and overflow handling on the exact route.

A variable-radius fillet now asks the kernel for tangent-ball corners (`ballCorners: true`, esaueng/remus#1942). Where three filleted edges meet at a vertex, the kernel closes the corner with an exact sphere octant, but only when it can prove the result is exact:

- each meeting law has exactly zero slope at the vertex;
- the radii agree there to within the linear tolerance;
- no other face reaches into the corner ball.

Any other corner is refused by code (`unsupported-setback-corner`). It is never patched with an approximate setback surface, and no setback is written into the document. The adapter calls `filletVariableDetailed` with exact-only acceptance, so a result the kernel would only disclose as approximate is refused as well.

A radius larger than the faces along an edge can carry is refused by type (`cliff-encountered`). The refusal relays the largest radius the kernel measured: "The faces along the edge carry a radius of at most N." The previous refusal was a bare build failure.

Tests:

- `packages/kernel-adapter/src/exact-variable-blends.test.ts`:
  - a three-edge corner closes with the tangent ball and matches the closed form;
  - a corner whose radii do not settle is refused by code;
  - an overflow is refused with the limit as data;
  - the request carries `ballCorners` and never a setback.
- `test/variable-blend-edit.test.ts`: an exact rebuild carries no approximate advisory.
- Pick-and-drag browser spec `test/e2e/variable-fillet-ball-corners.spec.ts`:
  - all 12 box edges under Eased, with the radius arrow dragged, rebuild exactly to the closed form (1 − π/4)·r²·(L − 24r) + 8r³(1 − π/6);
  - an oversized radius is refused with the limit shown.

Export/reimport agreement beyond the volume oracle:

- `test/variable-fillet-step-roundtrip.test.ts`: a 1 → 3 round under each law, exported to STEP and reimported, keeps its face count and its closed-form volume within 1e-6;
- an all-edge round's eight tangent-ball spheres survive the same round trip.

Independent check: on a 60 × 40 × 20 box rounded at 3 on all twelve edges, OCCT measured the STEP exports of the variable fillet and the constant one (cylinders and spheres) at 47109.07945 mm³ each, within 6e-5 mm³ of the closed form 47109.07939. The kernel's own volume integral over the corner-trimmed faces differs by about 5e-7 relative in both, so the browser spec bounds the volume to 5e-6 relative.
