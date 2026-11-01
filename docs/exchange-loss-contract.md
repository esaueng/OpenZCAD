# Exchange loss contract

What each export format keeps when it is exported and read back in, and
what it drops. `test/support/exchange-loss-contract.ts` holds the same
contract as data. `test/exchange-round-trip.test.ts` exports a closed-form
model through the app's adapter, reads it back the way the app imports it,
and checks every line below. The model is a 20 × 10 × 5 mm block plus an
R5 × 10 mm pin: 1000 + 250π mm³, spanning (0, −5, 0)–(45, 10, 10). A writer
that starts dropping a property the contract keeps, or quietly starts keeping
one it drops, fails that test.

No neutral format carries feature history. A reimported file is always
geometry: features, sketches, parameters and constraints stay in the
OpenZCAD project.

STEP and mesh exports include only visible result bodies. Hide, Isolate and
on/off parameters all affect export scope; consumed source bodies stay out.
A selected visible body exports alone. If every body is hidden, export is
disabled. Show a body in the viewport to include it in the file.

## Units

- **Export unit:** Settings → General → _Export units_. The mesh export
  dialog has the same control. It defaults to millimetres, which every export
  wrote before this preference existed. STEP and 3MF scale the geometry and
  state the unit in the file. STEP states inches as a 25.4 mm
  `CONVERSION_BASED_UNIT`. DXF states `$INSUNITS`. STL, OBJ and PLY scale
  their numbers but cannot say which unit they used. glTF is always metres,
  and SVG always states its physical size, so neither follows the preference.
- **Unitless imports:** STL, OBJ and PLY never state a unit, and some DXF
  files do not either. Importing one asks how to read it, preselecting what
  the import always assumed: millimetres for a mesh, the project's units for
  a DXF. Each choice shows the size it would produce. _Always read unitless
  files this way_ (or Settings → General → _Unitless imports_) stops the
  question. Files that state a unit (STEP, 3MF, GLB, a DXF with
  `$INSUNITS`) are converted without asking.
- **Mesh tolerances:** the mesh dialog's chord deviation (in millimetres)
  and _Max facet angle_. The 20° angle is the kernel's own default and
  leaves the export unchanged. _Check watertightness_ reports the
  tessellation the file will contain: its triangle count, and the largest
  distance from those triangles to the exact faces. Every triangle is
  measured at its stored float32 corners, which can sit off a tilted or
  distant plane. Curved triangles are also measured at their centroid and
  edge midpoints. Above 40,000 triangles the check measures a stride and
  says _(sampled)_.

## Solid formats

| Format       | Keeps                                                                                                                                                                    | Drops                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| STEP (AP214) | Each body as its own solid named after the body and styled in its display colour, the document as the product, exact analytic faces, bounds, volume, closed shells, unit | History                                                                                      |
| STL (binary) | Bounds and volume within the chord tolerance, a closed surface                                                                                                           | Body separation (one facet stream), exact faces, unit, names, colours                        |
| STL (ASCII)  | Same as binary STL                                                                                                                                                       | Same as binary STL; every body shares one `solid` block                                      |
| 3MF          | Bounds, volume, a closed surface, declared unit, one object per body in the package                                                                                      | Body separation **on reimport** (the import merges the objects), exact faces, names, colours |
| OBJ          | Bounds, volume, a closed surface                                                                                                                                         | Body separation, exact faces, unit, names, colours (no MTL)                                  |
| PLY (binary) | Bounds, volume, a closed surface                                                                                                                                         | Body separation, exact faces, unit, names, colours                                           |
| glTF (GLB)   | Bounds, volume, a closed surface; metres and +Y up through its root node                                                                                                 | Body separation (one merged mesh), exact faces, export unit, names, colours                  |

STEP body names and colours are in the file for other CAD to read; OpenZCAD's
own STEP import does not yet apply them to the bodies it creates (I02).

"Within the chord tolerance" means each bound lies within the chord
deviation of the exact value. Volume never exceeds the exact value, and it
falls short by at most the curved area times the chord deviation. A mesh
reimport is one imported-mesh body whatever the file held. When an STL, OBJ
or PLY was written in a unit other than millimetres, the reimport is only
the right size if the import is told that unit.

## Sketch formats

| Format                  | Keeps                                                                                        | Drops                                                                                                                                                            |
| ----------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DXF (R12, whole sketch) | Lines, arcs and circles exactly, sketch-local coordinates, `$INSUNITS`                       | Constraints, dimensions and rectangle or polygon identity (a rectangle returns as four lines), construction geometry, the sketch plane (the import uses Top, XY) |
| SVG (whole sketch)      | Lines, circles and arcs, physical width and height (mm, cm or in), viewBox in document units | Construction geometry, the sketch plane, constraints. There is no SVG import (I07), so it is write-only: the test measures the file itself                       |
