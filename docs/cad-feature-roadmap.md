# CAD feature roadmap (2026-08-29)

**Scope.** The product-level companion to
[kernel-roadmap-remus.md](kernel-roadmap-remus.md): what OpenZCAD needs as a
*CAD application* — features and functions users of parametric MCAD expect —
to be the best open-source web-based CAD of its kind. The kernel roadmap says
what the geometry engine must do; this document says what the product must
let people do with it, benchmarked against the mainstream parametric tools
(SolidWorks, Onshape, Fusion 360, Shapr3D) and the open-source bar
(FreeCAD 1.1, which shipped an integrated assembly workbench with joints and
a datum system in March 2026).

**Method.** The current-state inventory below was verified against source at
schema v13 (`packages/shared/src/index.ts`, the forms and interaction machine
in `apps/web`), not against the docs — several planning docs understate what
ships (see §8). Items are judged by three questions: does the mainstream
expect it, does the kernel already support it, and does it compound with what
exists.

---

## 1. Where OpenZCAD already stands

Worth stating first, because the strategy is to extend strengths, not to
chase every checkbox.

**Already competitive or better:**

- **Exact B-rep modeling in the browser** with a 22-kind feature history:
  primitives, sketch/extrude (two-sided, symmetric, multi-profile,
  operation-inferred), partial revolve, loft, sweep, helical sweep,
  booleans, transform (uniform scale), mirror, shell, solid offset, draft,
  thicken, fillet, distance-angle chamfer, linear/circular/grid patterns,
  split, hole (simple/counterbore/countersink, face-positioned),
  nine direct-edit operations, STEP and mesh import.
- **Direct manipulation** at Shapr3D quality of intent: face-offset and
  radius drags, edge-drag fillet/chamfer, region-drag extrude, move/rotate
  gizmo, numeric entry everywhere, selection filters, box select, depth
  cycling, marking menu, Esc ladder.
- **Sketch text** with seven bundled font families, extrudable and
  edit-stable.
- **Expressions and named parameters** on every numeric field, with a
  curated Tweak mode reachable from a share link — a genuinely
  differentiated "configurable part" story.
- **Local-first with real collaboration**: IndexedDB autosave, offline
  reopen, cloud sync with honest divergence handling, owner/editor/viewer
  roles, edit leases, save-state restore and branching, rollback markers,
  feature suppression and reorder.
- **AI assistant** with digest-bound, preflighted, one-transaction
  proposals and drawing/PDF ingestion with a dimension audit — ahead of
  every open-source peer and most commercial ones.
- **Measurement workbench** with per-measurement exactness provenance —
  no mainstream tool labels a measurement `exact-analytic` vs `tessellated`.

**The four structural gaps against the mainstream:**

1. **Sketching is not yet constraint-complete** — the single most
   consequential gap, because sketches are the foundation of every
   downstream feature (§2).
2. **No drawings** — no sheets, views, dimensions, or PDF; the only 2D
   output is a single-face DXF R12 outline (§5).
3. **No assemblies** — schema nodes exist (`AssemblyNode`, `PartNode`)
   but one project is one part; no instances, joints, or BOM (§6).
4. **No reference geometry** — no datum planes/axes/points or user
   coordinate systems; sketch planes are canonical+offset or a body face
   (§3).

---

## 2. Sketching to constraint-complete — highest product priority

The solver is ahead of the UI: the GCS layer supports 13 constraint kinds
(`gcs-sketch.ts`) and the schema stores the app-facing set. Every schema-backed
kind now has a direct creation tool: distance and angle use a pick-pair, canvas
placement, expression-aware value editor, and immediate solve transaction. The
fastest meaningful win in the entire roadmap was exposure, not construction:

- **S-1. Expose the seven solver-ready constraints**: perpendicular, equal,
  concentric, midpoint, and — the important three — **driving distance,
  angle, and radius dimensions** placed as on-canvas annotations. A
  dimension you can click and retype on the sketch is the core parametric
  gesture in every mainstream tool; today numbers live only in the entity
  editor and constraint list.
- **S-2. Dimension display**: witness lines/arrows already exist
  (`dimensionGraphic.ts`, used by drag rigs); reuse them for persistent
  sketch dimensions, driven-vs-driving state, and expression binding
  (a dimension bound to a named parameter).
- **S-3. Constraint status**: a DOF/under-over-constrained badge beyond
  the current solve-status tone; on-hover highlight of constrained
  entities; conflict diagnostics naming the removable constraint.
- **S-4. Constraint-capable rectangles and polygons**: today they are
  single parametric nodes with no point identity, so they cannot join the
  constraint system. Either decompose on demand or give corners identity.
- **S-5. Sketch editing tools**: trim, extend, offset, sketch
  fillet/chamfer, mirror, linear/circular sketch patterns. These are
  table-stakes in every benchmark tool and absent today.
- **S-6. Project/convert entities**: project model edges and silhouettes
  of other bodies into the active sketch as reference or geometry — the
  bridge between bodies that makes multi-body and (later) in-context
  assembly work possible. Depends on kernel curve-projection (kernel
  roadmap C2/M7.4).
- **S-7. New entity types**: spline (control-point and through-point),
  ellipse, slot, point. Béziers already exist internally for text glyph
  contours; the region engine handles general curves.

**Disposition (2026-08-30, P1-S1 Slice A): shipped in PR #142.** The four
non-dimensional solver-ready constraints now have pick predicates, rail tools,
undoable command creation, and real-GCS geometric-oracle coverage, including a
typed unsatisfied conflict result. The driving-dimension remainder is completed
by Slice B; S-2 remains open for persistent annotations.

**Disposition (2026-08-30, P1-S1 Slice B):** — done (PR #TBD); distance/angle placement, expression editing, transactional solve, real-GCS rollback oracles, and Playwright geometry/undo coverage shipped; S-2 persistent graphics remain separate.

Everything above is app-side except S-6; the solver, region engine, and
snapping already carry it.

## 3. Reference geometry and part-modeling depth

**R-1. Datum planes, axes, points, and named coordinate systems** as
document nodes: offset/angled/mid-plane/three-point planes, axes from
edges/cylinders/intersections, points from vertices/centers. This is the
prerequisite that quietly blocks a dozen other items: revolve about a model
axis (today the axis is in-sketch horizontal/vertical only), mirror about a
datum, patterns about an axis, section planes, lofts between angled planes,
and assembly mates later. FreeCAD 1.1 shipping a datum system is the
open-source bar here.

**Feature depth**, in order of user pull:

- **F-1. Extrude end conditions**: to-face / to-next / through-all /
  offset-from-face (kernel: a bounded boolean against the target — no new
  kernel work), plus per-side draft angle (kernel `draft` exists).
- **F-2. Variable-radius fillet and asymmetric chamfer**: the kernel's
  radius-law machinery exists (kernel roadmap C4 / P-Class 5.1 qualifies
  it); the form needs per-vertex radii UI.
- **F-3. Hole feature depth**: multi-position holes in one feature
  (positions or sketch-point-driven), standards library (clearance/tap
  drill tables for ISO/ANSI), cosmetic thread display, tapped-hole
  callout metadata for drawings later. Today one hole per feature, no
  standards.
- **F-4. Pattern depth**: pattern-along-path, mirror-pattern, per-instance
  suppression, pattern of features (not just bodies). Blocked in part by
  the kernel pattern-overlap defect (kernel roadmap S1.2) — fix that
  first.
- **F-5. Sweep/loft depth**: guide rails and twist for sweep, loft guide
  curves and end-tangency — kernel M7.1/7.2 items; expose in the same
  release the kernel lands them ("not done until JS can call it" cuts
  both ways).
- **F-6. Rib/web feature**: thin-extrude from an open profile — mostly
  app-side over existing extrude+boolean.
- **F-7. Move/delete face as first-class direct edits** on any body —
  arrives with kernel M6; the direct-edit UI pattern already exists.
- **F-8. Imported-feature editing completion**: boss, pocket-depth, and
  taper-angle coordinated commands over the already-proven recognizer
  families (kernel roadmap C5). The recognizer proves six families;
  only the three hole families are editable today.

## 4. Analysis and inspection

- **A-1. Show the full mass-property set** already computed: inertia
  tensor and principal axes are published in `BodyMassProperties` but the
  Inspector shows only COM + principal moments. Material density presets
  turn unit-density numbers into real mass.
- **A-2. Interference/clash detection** between bodies (kernel P-Class
  7.5 clash/clearance with witness points) — also the seed of assembly
  interference later.
- **A-3. Section view depth**: arbitrary/datum-plane sections, capped
  section fill, and a face-aligned option. Today: display-only XY/XZ/YZ
  clipping with an offset slider.
- **A-4. Draft-angle and curvature analysis** overlays (kernel 7.5
  read-only maps) — manufacturability checks that are cheap UI over
  kernel queries; thickness analysis follows.

## 5. Drawings and 2D output — the largest greenfield

Today: nothing — no sheets, no views, no 2D dimensions, no PDF. The kernel
already ships hidden-line projection (`projectEdges`, Stable), and the AI
already *reads* drawings with a dimension audit; producing them is the
missing other half. Staged:

- **D-1. Drawing MVP**: a drawing sheet document section with standard
  views (front/top/right/iso) from HLR projection, scale, and PDF export.
  Even dimension-less, this unlocks "send it to the shop".
- **D-2. Dimensions and annotations**: reuse the sketch dimension
  machinery (S-2) on projected views; centerlines, hole callouts (fed by
  F-3 metadata), notes, title block with parameter binding.
- **D-3. Section and detail views** (kernel `section` is bound and
  unused; detail views need the region-of-interest cropping already noted
  in TODO.md).
- **D-4. DXF growth**: whole-sketch and flattened-view DXF export (today:
  single planar face outline, R12), and DXF *import* into a sketch — the
  laser-cutter/CNC-router crowd is a natural web-CAD audience.
- **D-5. Round-trip with the AI dimension audit**: the audit already maps
  read dimensions to views; drawings close the loop (TODO.md's "editable
  parameter overrides" idea).

## 6. Assemblies — second greenfield, schema already seeded

`AssemblyNode`/`PartNode` and `activePartId` exist in the schema with no
UI. The kernel's assembly hierarchy/transforms/BOM went Stable on
2026-08-21, and clash detection is planned (P-Class 7.5). Staged:

- **AS-1. Multi-part documents**: create/switch parts within a project,
  part instances with transforms, a parts browser. This alone covers the
  dominant hobby/prosumer case (print plates, kit layouts).
- **AS-2. Joints/mates**: start with the modern joint model (Onshape/
  Fusion-style typed joints: rigid, revolute, slider, cylindrical,
  ball) rather than legacy mate stacks; degrees-of-freedom drag preview.
  A kernel 3D-constraint solver is *not* required for the MVP — rigid
  placement plus kinematic drag on typed joints covers most use — but
  full assembly solving should be scoped with the kernel team (the 2D
  DogLeg GCS is not a 3D assembly solver).
- **AS-3. BOM and exploded views**: BOM from the kernel's deterministic
  assembly BOM; exploded views as stored per-instance offsets (pure
  app/viewport work, also feeds drawings).
- **AS-4. Interference detection** across the assembly (A-2 applied
  pairwise) and STEP assembly-structure export/import (kernel already
  flattens; true structure round-trip is the kernel ask).
- **AS-5. In-context editing** (edit a part against assembly references)
  — deliberately last; it needs S-6 projection plus cross-document
  lineage, and is where mainstream tools accumulate their worst
  complexity. Design doc before code.

## 7. Interoperability, visualization, platform, AI

**Interoperability:**

- **I-1. Mesh import beyond STL**: 3MF/OBJ/glTF import are already in the
  kernel; the UI accepts only `.shapr,.stl,.step,.stp`.
- **I-2. Shapr3D semantic replay**: `io-shapr` already parses sketches,
  constraints, and a graded operation history but applies only the exact
  STEP body plus a provenance record. Replaying the `proven` subset into
  native features would be a unique migration story; gate it behind the
  same fail-closed grading.
- **I-3. STEP assembly structure** (with AS-4) and STEP colors/names
  (kernel inherited-queue e3b).
- **I-4. Post-creation unit conversion** — explicit, whole-document,
  once; today units are fixed at project creation.

**Visualization:**

- **V-1. Appearance beyond flat color/opacity**: a small curated material
  set (metal/plastic/glass presets), matcap or IBL environment — enough
  for screenshots people share; not a render engine.
- **V-2. Exploded views** (with AS-3). **V-3.** Capped sections (A-3).

**Platform:**

- **P-1. Touch/tablet interaction pass**: the direct-manipulation model
  is already touch-shaped (Shapr3D proved the market); audit the gizmos,
  marking menu, and numeric keypad on pointer-coarse devices.
- **P-2. Installable PWA** wrapping the existing offline-capable core.

**AI:**

- **AI-1. Close the vocabulary gap**: the patch schema lacks hole, split,
  loft, sweep, helical-sweep, draft, thicken — all shipped features. Every
  gap is a request the assistant must refuse.
- **AI-2.** As sketch dimensions (S-1/S-2) land, let proposals place and
  edit driving dimensions — the natural language "make the flange 3 mm
  thicker" maps to a dimension, not a raw field.

---

## 8. Stale-doc corrections (fold into the next docs pass)

- `docs/plans/text-feature-plan.md` says "planned, not started" — the
  text feature is fully shipped (schema, 7 font families, `T` tool).
- `docs/capability-matrix.md` is at schema v6 / 2026-08-04 and predates
  text, hole, split, draft, thicken, loft/sweep/helical-sweep, sketch
  constraints, save-state restore/branching, and section view. Refresh or
  banner it.
- The stale `TODO.md` sketch-constraint claim was corrected with P1-S1; direct
  creation now covers every schema-backed kind. Persistent dimension graphics,
  status feedback, and entity identity remain tracked above.

---

## 9. Sequencing

Phases group by dependency and compounding value; kernel-column items
cross-reference [kernel-roadmap-remus.md](kernel-roadmap-remus.md).

| Phase | Items | Kernel dependency |
| --- | --- | --- |
| **1. Foundation** (highest leverage, mostly app-side) | S-1…S-5 constraint-complete sketching with dimensions; R-1 datum geometry; F-1 extrude end conditions; A-1 mass properties; AI-1 vocabulary; I-1 mesh import; stale-doc pass | none |
| **2. Feature depth** | F-2 variable fillet; F-3 hole depth; F-4 patterns; S-6/S-7 projection + splines; A-2/A-3 clash + sections; D-4 DXF growth | C4 blends, S1.2 pattern fix, C2 projection, 7.5 clash |
| **3. Drawings MVP** | D-1 sheets/views/PDF; D-2 dimensions/annotations; D-3 sections/details | HLR is ready today |
| **4. Assemblies MVP** | AS-1 multi-part; AS-2 joints; AS-3 BOM/exploded; V-2 | kernel assemblies ready; clash for AS-4 |
| **5. Depth & reach** | F-5 sweep/loft depth; F-7 direct modeling; F-8 imported-feature completion; I-2 Shapr replay; I-3 STEP structure; AS-4/AS-5; P-1/P-2; V-1 | M6, M7, C5, e3b |
| **Later** | Configurations/design tables (grows out of the parameter system + Tweak mode); surfacing workflows (kernel M4 sheet bodies); sheet metal; simulation hooks | M4 |

Phase 1 is deliberately kernel-independent: it is the largest gap-per-effort
in the product and can proceed in parallel with the kernel roadmap's
stability track. Phases 3 and 4 are the two greenfields that most change
what the product *is* — a drawings MVP makes it usable end-to-end for
manufacturing handoff, and assemblies make it usable for products rather
than parts. Both have their kernel prerequisites already Stable, which is
unusual and worth exploiting.

## 10. What to protect while building

The differentiators to not regress in pursuit of parity: exactness honesty
(fail-closed refusals, measurement provenance labels — extend both to every
new feature), local-first behavior (every new subsystem works offline;
drawings and assemblies included), the one-transaction/undoable contract for
every user action including AI patches, and share-link Tweak mode (each new
parametric surface — sketch dimensions, hole standards, joint limits —
should be exposable there). These are the things the mainstream tools
cannot easily copy.
