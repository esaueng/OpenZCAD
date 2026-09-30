# FreeCAD hands-on comparison for the OpenZCAD roadmap

Reviewed 2026-09-30 in the installed FreeCAD 1.1.3 Windows interface. OpenZCAD
was compared against its local roadmap and supporting specifications at
`7662d25ab7af37fcb9e61ad150c77f1533a51a0a`; this record is not a rendered
OpenZCAD audit, kernel qualification or production acceptance report. Roadmap
integration was refreshed against `b09d9892` before editing.

The comparison supports finishing understandable sketch/parameter editing,
dependable references and a dimensioned drawing handoff before broadening
specialist capabilities. [ROADMAP.md](../../ROADMAP.md) remains the only
priority and delivery-status ledger. This review changes no delivery status.

## Hands-on evidence

A fresh synthetic document was created through the GUI; no existing user model
was edited. The document remains open and unsaved. Outcomes below are visual/UI
observations, not independently measured exact-geometry oracles.

| Evidence | Action and observed result | Boundary |
| --- | --- | --- |
| E01 — Start | Inspected Parametric Body, Assembly, 2D Draft, BIM/Architecture, Empty File and Open File cards, short descriptions and recent-file cards. Used Parametric Body. | Other start paths were not exercised. |
| E02 — Sketch entry | New Sketch showed named XY/XZ/YZ planes in a list and corresponding planes in the viewport. Selecting XY entered a normal-to-plane view. | Face attachment and external-reference choices were inspected only. |
| E03 — Sketch drawing | Used Rectangle, anchored the first corner at the origin and clicked the opposite corner. Cursor-adjacent numeric inputs appeared; visible relations and a two-DOF readout followed completion. Rounded-corner/frame options and corner/width/height mode were visible. | Exact typed width/height, rounded corners, fully constrained behavior and conflicts were not tested. |
| E04 — Feature edit | Created a 10.00 mm Pad, reopened it by double-clicking the history object, entered `5 mm + 2 cm` in its expression editor, observed `25.00 mm`, and accepted the changed preview and solid. Ctrl+Z restored the shorter solid. | Visual agreement only; no independent volume, export or persistence oracle. |
| E05 — Extents | Inspected Pad taper, reverse, direction, recompute and preview controls. Its extent menu listed Dimension, To last, To first, Up to face and Up to shape. | Only Dimension was exercised. |
| E06 — Drawing | Created a TechDraw Page and ProjGroup, added two aligned secondary projections with a small grid, and displayed an edge dimension of 32.23 below the base view. The tree named the views Front, Bottom and Left. The committed views were visible after refreshing the page state. | Projection convention, exact dimension provenance, associativity after edits, save/reopen and export were not qualified. |
| E07 — Assembly | Created and activated Assembly, opened the insertion browser, inserted Body as Body001 with Linked Object = Body, accepted grounding for the first component and committed insertion. A lock symbol was visible. | One component only; no multi-component motion, joint solve, BOM or exploded view was tested. |
| E08 — Breadth | Inspected the chooser: Assembly, BIM, CAM, Draft, FEM, Material, Mesh, Part Design, Part, Points, Reverse Engineering, Sketcher, Spreadsheet, Surface and TechDraw. | Inventory does not prove complete or reliable workflows. |

The accessible TechDraw inventory included section/detail/broken views,
dimension-reference repair, centerlines, cosmetic thread representations,
balloons, annotations, hatching and SVG/DXF export. Assembly exposed fixed,
revolute, cylindrical, slider, ball, distance, parallel, perpendicular, angle,
rack-and-pinion, screw and gear/belt joints, plus solve, simulation, exploded
view and BOM commands. These commands were inspected, not executed.

Save/reopen was not verified: the Save As dialog was opened, but file-name
automation did not complete and the dialog was canceled. No export round-trip,
performance benchmark, advanced kernel stress test or specialist-workbench
evaluation was completed. No private desktop captures or identifying metadata
are included in this record.

## Design lessons

**Actionable sketch feedback.** Immediate DOF status and relation graphics make
incompleteness visible. For OpenZCAD, navigate to relevant entities/constraints
only where solver evidence permits; a DOF number alone is not an explanation.
Preserve unknown attribution when evidence is insufficient. Cursor-adjacent
numeric drawing is a prototype candidate, not proof that OpenZCAD should replace
its sketch mode boundaries.

**One coherent feature value.** Reopening Pad and changing a mixed-unit
expression provided a concrete input → resolved value → preview → commit → undo
benchmark. F05 already owns the grammar audit; U01 owns agreement across input
surfaces. Do not infer a missing grammar feature from this comparison alone.

**Inspectable model relationships.** FreeCAD distinguishes body/features,
drawing/page/projection groups and assembly/linked instances in the tree, with
Data/View properties. Adopt role and dependency visibility through U06, R01 and
I01. Generic property tables and dense icon strips impose a discoverability
cost; keep OpenZCAD's quiet-stage shell and optional expert metadata instead of
copying that density.

**A drawing handoff, not outlines alone.** The projection grid efficiently
selects aligned view families. The contextual dimension tool and inspected
repair command support making a bounded D02 slice part of the drawing product
milestone. This is a proposed OpenZCAD acceptance requirement, not evidence that
FreeCAD annotation repair or associativity was tested.

**Instances before solving.** Component insertion, explicit source identity and
first-component grounding are useful before motion constraints. AS01 should
define those semantics, including persistence; AS02 retains joint behavior.
OpenZCAD's cross-project import must not silently promise a live external link.

## Roadmap acceptance updates

These refinements stay under existing master IDs and retain their status. They
do not override H01/H02's remaining acceptance/performance work, reproduced
U01/U02 defects or L01 live checks.

| Owner | Refinement | Observable acceptance |
| --- | --- | --- |
| S03/S02 | Navigable constraint feedback; keep reference measurements distinct from driving constraints. | Status, relevant highlighting and constraint-list state agree; conflict preserves the prior solution; reference dimensions never implicitly constrain geometry. |
| U01/F05 | Mixed-unit expression edit as a coherence case; audit before expanding grammar. | Expression intent, resolved units, preview, commit, undo/redo and reopen agree; cycles and incompatible dimensions refuse without model loss. |
| R01/I01/U06 | Supported source/dependent navigation and original/copy/instance roles. | Upstream edits update supported dependents; deletion/ambiguity produces a named broken reference and explicit qualified re-pick. No proximity rebinding. |
| S06/S08/U05 | Prototype cursor-adjacent drawing inputs within current mode and command contracts. | Pointer/keyboard behavior, units, focus/cancel and inspectable/removable inference remain coherent; adoption needs task-step/error evidence. |
| D01/D02 | A bounded dimensioned shop handoff; explicit annotation repair. | Aligned scaled views plus a useful dimension survive reopen; explicit source rebind updates or visibly invalidates annotations; PDF uses the same scale/units; broken references retain placement/formatting. |
| AS01/AS02 | Source identity, independent placements, grounding and copy/link behavior before solving. | Two supported instances share a source while keeping independent placement; grounded state persists offline; conflicts/motion are separately qualified under AS02. |
| F04a | Representative GUI-authored saved-solid qualification when redistributable. | Final-body selection, units, placement, visibility and exact export/reimport prove only the supported subset. Linked instances/native history remain unsupported. |
| L05 | Separate demand-led discovery/design for design tables, surfacing, sheet metal and simulation. | Each has a user task, data contract, dependencies and measurable acceptance. CAM/BIM and advanced mechanical couplings do not enter the near-term queue from inventory alone. |

## Roadmap reconciliation

- S01 is Complete in the ledger, so saved driving-label placement must leave
  the next-picks sentence and the baseline must no longer describe it as open.
- S04 already has a composite-identity design; implementation against that
  design replaces a generic new design task in steering.
- H02's newer measurements and publication-determinism evidence supersede the
  old instruction to measure before pinning any budget. Steering should name
  its remaining branch-lifetime, private fresh-build/B-rep-equivalence and
  worker-heap work; H01 should point to its remaining acceptance matrix cases.
- D01's initial design qualifies a shared sheet scale. Per-view scale remains
  a later D01 design/acceptance slice. D02 owns title-block layouts and
  automatically filled fields; neither is delivered by the D01 design record.
- FreeCAD import already belongs to F04a. Native sketches, constraints,
  expressions, spreadsheets, history and linked instances must not be described
  as transferred by its saved-solid converter.

## Sources

Primary evidence is the installed UI walkthrough E01–E08. Supporting OpenZCAD
contracts: [quiet-stage workspace](../plans/quiet-stage-workspace-plan.md),
[workspace coherence](../plans/workspace-ui-coherence-plan.md),
[reference dimensions](../plans/sketch-reference-dimensions-plan.md),
[datum geometry](../plans/datum-geometry-plan.md),
[drawing MVP](../plans/drawing-mvp-design.md) and
[FreeCAD saved-solid import](../freecad-import.md).

The official [FreeCAD features overview](https://freecad.github.io/Website/features/)
documents its parametric objects, geometry engine, formats and specialist
workbenches. The [FreeCAD 1.1 announcement](https://freecad.github.io/Website/news/freecad-version-1-1-released/)
identifies transparent Part Design previews and interactive dress-up controls.
They provide context, not verification of the untested workflows above. The
wiki release notes were unavailable through the web reader and were not used
as verified evidence.
