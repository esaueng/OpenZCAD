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

| Format       | Keeps                                                                                                                                                                    | Drops                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| STEP (AP214) | Each body as its own solid named after the body and styled in its display colour, the document as the product, exact analytic faces, bounds, volume, closed shells, unit | History                                                                                         |
| STEP (AP242) | Same as AP214, plus the model's datum features and feature control frames as semantic PMI on their faces                                                                 | History                                                                                         |
| IGES (B-rep) | Each body as its own type 186 solid, exact analytic and B-spline faces, bounds, volume, closed shells, cavities, the stated unit                                         | Names, colours, history                                                                         |
| STL (binary) | Bounds and volume within the chord tolerance, a closed surface                                                                                                           | Body separation (one facet stream), exact faces, unit, names, colours                           |
| STL (ASCII)  | Same as binary STL                                                                                                                                                       | Same as binary STL; every body shares one `solid` block                                         |
| 3MF          | Bounds, volume, a closed surface, declared unit, one object per body in the package, named after the body and coloured in its display colour                             | Body separation **on reimport** (the import merges the objects), exact faces                    |
| OBJ          | Bounds, volume, a closed surface, one object per body named after it (`o`); with _OBJ colors_, a material per display colour in the MTL beside it                        | Body separation **on reimport**, exact faces, unit, colours in a single OBJ (they need the MTL) |
| PLY (binary) | Bounds, volume, a closed surface                                                                                                                                         | Body separation, exact faces, unit, names, colours                                              |
| glTF (GLB)   | Bounds, volume, a closed surface; metres and +Y up through its root node; one node and mesh per body, named after it, in a material of its display colour                | Body separation **on reimport** (the import merges the meshes), exact faces, export unit        |

**STEP structure (I02).** Export writes Objects folders as an assembly: the
project is the root product, each folder a sub-assembly and each body a part
named after it, every one placed with an identity transform, so a reader that
ignores products still reads the same solids. Import reads a file's product
structure: every placed occurrence of a part becomes its own body, where the
assembly places it, named after its part (or after its solid, when the file
names it), coloured as the file colours it, and filed in folders that follow
the assembly tree (a file with one product stays at the top level). An
OpenZCAD project exported and imported again comes back with the same body
names, colours and folders, inside one folder named after the project.
Repeated parts become independent bodies (no shared definition), occurrence
names and per-occurrence colour overrides are not read, and a face coloured
differently from its body keeps only the body's colour. A file whose structure
cannot be read (mapped-item assemblies, for one) is still imported with the
flat reader, at each part's own origin, and the import says so.

**STEP protocol:** Settings → General → _STEP protocol_ picks what File ›
STEP states: AP214 (automotive design, the default and what every STEP export
wrote before the choice existed) or AP242 edition 1 (managed model-based 3D
engineering). Both files hold the same geometry and presentation entities
after the header; an AP242 file also carries the model's PMI (D07) as
semantic datum features, datums and geometric tolerances, each tied to the
exact face it applies to. Insert project always travels as AP214.

3MF names and colours: each `<object>` carries its body's `name`. Its colour
is written twice. One core `<basematerials>` group holds a `<base>` per
distinct display colour, listing the model's colours. The Materials
extension (`xmlns:m`, declared but not required, so any 3MF reader still
opens the file) holds one `<m:colorgroup>` per distinct colour with that one
`<m:color>`, and each object selects its colour's group with `pid` and
`pindex="0"`. One group per colour is what OrcaSlicer needs: it keeps a
single colour per `m:colorgroup` and matches it by `pid` alone. An object names only
one property group, so a reader of the core format alone finds the colours
in `basematerials` but no object bound to them: it opens the geometry
uncoloured. That is the trade for OrcaSlicer; of the slicers below, the two
that read 3MF colours at all both read the colour groups.

What the
common slicers do with it, read from their public 3MF importers:

| Slicer (source read)                                         | Parts                                                                                                                          | Colours                                                                                                                                                                                                                                  |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bambu Studio (main 2026-11-17; colour import in 02.09.01.70) | One named object per body. Bodies resting at different heights load, without asking, as one object with a part per body.       | Each distinct colour becomes a filament: it reads `basematerials` and `m:colorgroup` alike by `pid`/`pindex`. A file with colours first opens the colour import dialog, where _Skip_ loads the geometry only.                            |
| OrcaSlicer (main 2026-11-20)                                 | One named object per body. Bodies resting at different heights prompt whether to load them as one object with a part per body. | Each distinct colour becomes a filament, from the object's `m:colorgroup` (it reads no `basematerials`).                                                                                                                                 |
| PrusaSlicer (main 2026-11-06)                                | One named object per body. With a multi-material printer it may offer to load them as one object with a part per body.         | Not read, in any encoding: it parses an object's `pid`/`pindex` but never uses them, its `basematerials` handling is commented out and it has no `m:colorgroup` reader. No 3MF property can colour a body there; it is left to the user. |

The filament each body starts on in Orca and Bambu is checked by
`orcaSlicerFilaments` and `bambuStudioFilaments` in
`test/support/three-mf-export.ts`, which follow those importers' rules.
None of this was confirmed in a running slicer; it is what each importer's
source does with these elements. OpenZCAD's own 3MF import still merges the
objects into one body and does not read names or colours back.

**Mesh export package (I04).** The mesh export dialog can write _one file
per body_, _also export_ the same scope in further formats, and add _OBJ
colors (.mtl)_. Whenever that makes more than one file, they download
together as one `.zip` (an OBJ with colours is its `.obj` and `.mtl`). Body
files are named after the project and the body. The dialog remembers its
format and package choices in this browser for the next export.

**IGES (I06).** File › Export IGES writes the shown bodies as IGES 5.3
manifold solid B-rep objects (type 186) in the export unit: planes,
cylinders, cones, spheres and tori as their exact IGES surfaces, B-spline
faces as 128, no names or colours. Import CAD files reads `.igs`/`.iges`
files of 186 solids through the same exact path: the Remus translator
restates the B-rep as STEP, and that STEP text is what the project stores,
archives and rebuilds from, under the IGES file's name. A file of trimmed
surfaces with no 186 solid (a surface model) is refused, naming how many
surfaces it holds; so are entity types outside that family and non-rigid
transformations, and a body whose closed edge has no carrier (the torus
primitive) is refused on export. The legacy preview reader is not used.

**Insert project…** (File menu) copies another project's shown bodies into
the open one as one undoable step: each keeps its name, chosen colour and
opacity, its exact faces and its size in the open project's unit, and the
set is filed in an Objects folder named after the project. It travels as a
STEP, so it drops the same things a STEP does — history, parameters,
sketches, assembly and drawings — and keeps no link to the other project.
Mesh references and bodies whose history step failed are left out and named.
**Import project…** still opens the backup as a separate project.

"Within the chord tolerance" means each bound lies within the chord
deviation of the exact value. Volume never exceeds the exact value, and it
falls short by at most the curved area times the chord deviation. A mesh
reimport is one imported-mesh body whatever the file held. When an STL, OBJ
or PLY was written in a unit other than millimetres, the reimport is only
the right size if the import is told that unit.

STL import accepts up to 500,000 triangles per file within 128 MiB. Files
with more than 200,000 triangles need browser storage and open as mesh
references. They retain their source facets for display and STL export.
Solid modeling, solid volume and STEP export require a solid body. Use
binary STL for a large mesh round trip, since full-precision ASCII can
exceed the source byte limit. Reopening these bodies requires a build that
supports the larger STL limit.

## Sketch formats

| Format                  | Keeps                                                                                        | Drops                                                                                                                                                            |
| ----------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DXF (R12, whole sketch) | Lines, arcs and circles exactly, sketch-local coordinates, `$INSUNITS`                       | Constraints, dimensions and rectangle or polygon identity (a rectangle returns as four lines), construction geometry, the sketch plane (the import uses Top, XY) |
| SVG (whole sketch)      | Lines, circles and arcs, physical width and height (mm, cm or in), viewBox in document units | Construction geometry, the sketch plane, constraints. There is no SVG import (I07), so it is write-only: the test measures the file itself                       |
