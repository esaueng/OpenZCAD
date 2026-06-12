# ADR-005: Built-In Polyhedral Kernel With Faceted-B-Rep STEP Export

## Status
Accepted. Supersedes the mock-kernel behavior of ADR-004 (the adapter boundary it introduced is retained).

## Decision
Replace the mock kernel behind the `kernel-adapter` boundary with a small built-in polyhedral solid kernel (`packages/geometry`):

- Solids are polyhedral B-Reps: shared vertices plus planar, convex, outward-wound polygon faces.
- Primitives and profile sweeps (extrude, full revolve) generate exact prismatic geometry and fixed-density tessellations of curved geometry.
- Booleans run BSP CSG (csg.js algorithm) followed by vertex welding and T-junction healing, restoring shared-edge topology.
- `validateSolid` enforces the closed-shell contract (every undirected edge used exactly twice, once per direction).

STEP export is implemented natively in `io-step` as an ISO 10303-21 AP214 writer that emits this topology directly: faceted `MANIFOLD_SOLID_BREP`s with planar `ADVANCED_FACE`s, deduplicated `VERTEX_POINT`s/`EDGE_CURVE`s, and a complete product structure, scaled to millimetres.

## Rationale
- A real in-repo kernel makes the core promise of the product — model parametrically, export a true STEP file — hold today, with zero WASM payload and full determinism for replay tests.
- Faceted B-Rep is valid, importable STEP (FreeCAD/SolidWorks/Fusion read closed solids); the trade-off is planar faces only.
- The kernel-adapter seam is unchanged, so an OpenCascade.js adapter can later replace the geometry backend to add analytic surfaces, exact curved booleans, and STEP import without touching the document model or UI.

## Consequences
- Curved faces are tessellated at fixed segment counts; file sizes grow with tessellation density.
- Boolean results with coplanar overlapping faces can produce imperfect shells; the export path surfaces a warning instead of hiding it.
- STEP *import* remains metadata-only until the native kernel lands.
