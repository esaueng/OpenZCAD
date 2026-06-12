# OpenZCAD Roadmap

OpenZCAD is purely a CAD design tool; the roadmap stays within that scope.

## Done

- Parametric document model: parameter table, expression engine, editable/deletable features, deterministic replay, undo/redo.
- Built-in polyhedral kernel: primitives, extrude, revolve, real CSG booleans (consumed inputs), baked transforms, watertightness validation, volume/bounds.
- True STEP (AP214 faceted B-Rep) and ASCII STL export; full-geometry STL import.
- Classic three-pane workspace: parameters + feature history, viewport, tool/edit inspector.

## Next

- Multi-object sketches (several profiles per sketch, holes/pockets in one profile).
- Fillet/chamfer on polyhedral edges; shell/offset.
- Linear/circular patterns and mirror features.
- Partial-angle revolve and mid-plane/two-sided extrude.
- Face/edge selection in the viewport (pick a face to sketch on).
- Binary STL export; STEP export with colors.

## Later

- OpenCascade.js-backed kernel adapter: analytic STEP surfaces, STEP B-Rep import, exact curved booleans.
- Drawings (2D projections with dimensions) and measurement tools.
- Authentication, per-user projects, and collaboration (locks/presence already scaffolded).
- Assemblies with mates between parts.
