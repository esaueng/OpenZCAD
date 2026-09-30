# FreeCAD saved-solid import (F04a)

Choose **Import** or drop one `.FCStd` file into the workspace. ZCAD reads
FreeCAD's saved visible final bodies, converts their Open CASCADE BREP to STEP
in a disposable worker, and commits the result through the existing exact
Remus validation path. It imports separate solids as separate editable bodies
in one undo transaction. Imported geometry participates in ZCAD's existing
solid editing, autosave, reload, project backup, sharing and export paths.

This imports **saved solids**, not native FreeCAD sketches, constraints,
expressions, spreadsheets or feature history. No Python proxies, macros,
external resources or expressions execute. Recompute and save the document in
FreeCAD first. A stale saved shape cannot be detected without evaluating its
original feature history. The application reports that history was not
transferred after a successful import.

## Qualification and refusal boundaries

- Read FreeCAD document schemas 2–4, visible `PartDesign::Body` final shapes
  and standalone shape-bearing objects; exclude Body members and sketches.
  GUI visibility overrides document visibility when present. Parent `App::Part`
  placements compose from the nearest parent outward; the BREP already stores
  each object's own placement. Hidden Part containers exclude their children.
- FreeCAD BREP coordinates are millimetres regardless of its display-unit
  preference. Converted STEP declares those units; ZCAD's existing import path
  scales into the current project units. The committed synthetic two-box
  fixture is qualified for millimetre and inch projects. Every generated source
  must pass exact rebuild, STEP export and reimport qualification in the target
  project units before import. Known pinned-kernel periodic pcurve export
  issues refuse some cylindrical solids even when solid validation succeeds.
- Text BREP topology versions 1–3 are supported. Binary BREP, unsaved or null
  shapes, surfaces mixed with solids, visible linked instances, cyclic or
  multiply parented containers and malformed placements refuse atomically.
  Complex assemblies/workbench-specific placement semantics need separate
  qualification; use FreeCAD's STEP export for those workflows.
- All saved solids must survive ZCAD's discovery and exact preflight. There is
  no mesh fallback, pcurve deletion, surface replacement, guard bypass or
  tolerance change. Unsupported geometry leaves the document unchanged and
  displays the reason from the converter/kernel.
- Archive: 32 MiB; entries: 4,096; each XML file: 8 MiB; other entries: 32 MiB;
  declared decompressed output: 128 MiB; compression ratio: 200; document
  objects: 2,048; solids: 256; generated STEP: 128 MiB; conversion timeout:
  120 seconds. ZIP central/local records, paths, duplicates, encryption,
  overlap, decompressed sizes and selected-entry CRCs are checked. ZIP64 and
  XML document types/entities are refused. Cancellation terminates the worker.

The converted, privacy-sanitized STEP source is stored/archived using the
existing content-addressed import-source mechanism. The original `.FCStd`
archive and native history are not stored or uploaded by this importer; keep
the original for editing in FreeCAD. It is not necessary for ZCAD replay.
Only FreeCAD import loads the additional OCCT WASM converter (about 21 MiB
raw); the launcher and ordinary modeling stay on Remus.

## Evidence

`packages/io-freecad/src/*.{test,spec}.ts` covers saved-body selection, visibility,
placements, archive bounds and exact BREP-to-STEP roundtrips.
`test/parity/freecad-import.spec.ts` rebuilds the synthetic two-solid fixture in Remus,
checks physical volume, undo/redo, document reload and exact STEP export.
`apps/web/src/lib/freecadImportWorkerClient.test.ts` covers termination on
success, error, cancel and timeout.
`test/e2e/freecad-import.spec.ts` exercises the actual picker, independent
visibility, atomic undo/redo, reload and corrupt-file refusal.

Local supplied-model qualification found one valid saved OCCT solid with
curved fillet surfaces that the pinned Remus STEP reader refuses: a PCURVE
coordinate cannot be certified against the corresponding principal surface
coordinate. The model is not included in public fixtures. This remains an
upstream geometry-compatibility blocker, not a successful import or a reason
to relax validation. A second local probe found existing cylinder export refusals (a zero-range
pcurve in millimetres and a pcurve endpoint mismatch in inches); the new
export-qualification gate refuses these before commit.

The public fixture `test/fixtures/freecad/two-solids.FCStd` is synthetic,
generated with `occt-wasm` 3.8.4: a 10×20×30 mm box, a 5×8×12 mm
box translated 35 mm along X, and a deliberately visible intermediate
1 mm cube inside the Body that must not import. It contains no user model or
identifying metadata.
