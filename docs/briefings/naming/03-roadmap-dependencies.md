# 3. Roadmap rows that depend on stable references

**Method.** I split [ROADMAP.md](../../../ROADMAP.md) at `c73dccff3` into its 107
master-ID rows. I searched each row's outcome and dependency cells for
`lineage`, `stable`, `topolog*`, `persistent`, `identity`, `re-pick`,
`rebind`, `re-resolve`, `retarget`, `attach*`, `broken`, `unresolved`,
`stale`, `hash-only`, `ADR-011/013/014` and `K05`, then read the matching
sentences and every row's "Depends on" cell. A row is included when its
feature stores a reference to topology (or to a sketch entity that names
downstream topology), or re-resolves one on replay. A row is also included
when it consumes the lineage machinery directly (caches, fences, qualification
oracles). I read the linked specifications for limitations and checked
`docs/roadmap-evidence/` for unfolded fragments. Three fragments set a new
status on an included row (AS01, AS02 and M15 to `In review`). The others
cited below add evidence only.
Rows have no title column, so the titles are short paraphrases. Statuses quote
the row's Status cell. The [reference workflow plan](../../plans/reference-workflow-plan-2026-10-04.md)
was checked and has no naming contract.

Considered and excluded, all borderline: S01/S03/S07 (sketch-internal
constraint identity only), F05 (parameter-name references, not topology), H01
(holder recognition is not a stored pick), M13 (measurements are not
persisted with entity references), U05/U11 (they start commands that other
rows own), L08 (comments anchor to a point, not topology), L12 (per-face
material is not yet designed) and I02 (STEP metadata).

## Summary table

| ID | Title | Status | Reference dependency | Current limitation |
| --- | --- | --- | --- | --- |
| H02 | Cold/warm rebuild latency | Partial | Cached rebuilds must publish identical face/edge lineage | "five sustained publication comparisons fail in face/edge references and lineage diagnostics" |
| W02 | Checkpoint/restore validity | Revalidate | Suffix reuse is guarded by "exact operand handles and lineage" | Restore validity is still to "document/test… before cache changes" |
| U01 | Command/value coherence | Partial | In-place edits and Delete resolve picked faces/edges to owning features | "Stale Edit refuses"; ambiguous hole walls left unselected after undo |
| U02 | Feedback and naming | Partial | Face names derive from ADR-011 lineage; warning attribution for parameter replay | Faces "the lineage cannot place" keep the viewport name |
| U03 | Accessibility/design polish | Partial | Whole-outline Fillet/Chamfer turns a face pick into an edge set ([fragment](../../roadmap-evidence/u03--face-edge-chamfer.md)) | None stated; inherits K05's edge-lineage gaps |
| U06 | Objects/history organization | Partial | Shows source/dependent relations, broken projections and re-pick | Uniform "re-pick this reference" affordance remains |
| U09 | In-viewport commands | Done | Plane/axis sources picked in the model, "kept as the associative source" | None stated; R01 resolver limits apply |
| S02 | Reference dimensions | Partial | Stable `annotationId`; targets resolve or report `unresolved` | "Composite/datum targets (S02-D)… remain open" |
| S04 | Composite sketch identity | Partial | Corner/side identity so "downstream region references survive" | "Open: composite corner/side targets for snaps and S02-D" |
| S05 | Sketch modify tools | Partial | Trim "keeps the entity's identity where it can"; region side faces are named from sketch object ids | Persistent pattern relation and multi-entity selections open |
| S06 | Sketch entry and re-entry | Partial | Face-hover sketch entry creates face attachments | None stated; ADR-014 needs a v5 planar face |
| S08 | Inference while drawing | Open | Face/hole-centre guidepoints and projected off-plane geometry | None stated; would need I01-style linkage |
| R01 | Datum geometry | Partial | Face/edge/vertex/cylinder sources by lineage; explicit re-pick repair | Curve/edge-angle planes open; "No proximity-based rebinding" |
| F01 | Extrude extents and draft | Open | `toFace` "named by verified lineage"; through-all target | Planar faces only; "A drafted extrude publishes hash-only references" |
| F03 | AI operation vocabulary | Open | "Fillet all edges" builds edge sets from complete local topology | Vocabulary extension "has not started" |
| H03 | Broader holder recognition | Deferred | Guided face selection; depends on K05 | Deferred; axis-aligned recognition only |
| M01 | Hole depth | Open | Sketch-point positions and history edits | None stated; depends on S04/S05 point identity |
| M02 | Feature patterns | Open | Row requires "stable references"; depends on K05 | None stated; fused patterns lack lineage (K05) |
| M03 | Variable blends | Partial | Fillet/chamfer edge sets plus per-vertex controls | "Open: per-vertex controls"; no persisted vertex reference |
| M05 | Imported feature edits | Partial | Imported faces keep `import.step.*` names; blend edits carry lineage | "coordinated edit replay remain[s] open" |
| M07 | Move/delete face | Partial | Direct edits must keep "verified unchanged references" | Adjacency-changing edits refuse; previews defer reference publication |
| M08 | Sections | Partial | Datum/face-aligned planes would reference R01 sources | "Open: arbitrary/datum planes" |
| M10 | Transform depth | Partial | Rigid-transform lineage; align/rotate about picked edges/faces | Non-uniform scale "needs a qualified affine lineage path" |
| M11 | Keep originals and re-pick | Open | Re-pick target/tool and split by faces | Re-pick and "kept-body evolution evidence (K05)" remain |
| M12 | Wrap/emboss | Deferred | Maps regions onto a picked cylindrical/conical face | Representation undesigned |
| M14 | Gears | Partial | `gear.face.*` roles "so later fillets and holes survive edits" | Hash-only fallback for older picks; helical teeth open |
| M15 | Modeled threads | Partial (fragment: In review) | Thread "fitted to the face" of a boss or bore | None stated |
| I01 | Sketch projection | Partial | Linked projections re-find edges "through verified lineage only" | Curved silhouettes and spline/ellipse edges unprojectable |
| I03 | Unit conversion | Deferred | Must convert "persisted references" | Deferred; witnesses are quantized in document units (ADR-013) |
| I05 | Reference images | Partial | Image on a face "followed by lineage" | Faces without identity get "a fixed frame" |
| I07 | SVG exchange | Partial | Export resolves the sketch's plane attachment | Refuses "stale attachment" |
| D01 | Drawing sheets | Partial | Sheet fence fingerprints "persistent topology hashes" | Old-checkpoint replay refused; Update rebinds explicitly |
| D02 | Drawing annotations | Partial | Edges stored by ADR-011 hash plus ADR-013 reference | Broken annotations block export until re-picked |
| D03 | Section/detail views | Partial | Dimensions on cut-body edges | "lineage for cut edges" open |
| D04 | DXF exchange | Partial | Export resolves the sketch plane | Refuses `stale-plane-attachment` |
| D05 | Dimension audit to parameters | Deferred | Consumes D02 edge-bound dimensions | Deferred |
| D06 | Auto-dimensioning | Partial | Assistant refs grounded "to its model edge" with lineage | Revolved faces hash-only (plan) |
| AS01 | Components | Open (fragment: In review) | Components "reference bodies… following the bodies' lineage" | Source-change contract to define |
| AS02 | Joints | Open (fragment: In review) | Joint frames "picked on geometry" | Frames stored as numbers; re-resolution is a follow-up |
| AS05 | In-context editing | Deferred | "cross-part source references, lineage" | Design before code; depends on K05 and I01 |
| K01 | Kernel workaround retirement | Partial | Face unification changes topology under stored refs | Downstream survival shown only on private replay |
| K05 | Verified evolution | Partial | The lineage producer for every row above | "multi-operand booleans… publish no edge lineage; chamfer, shell/offset, other direct-edit kinds, STEP provenance" |
| K06 | Kernel topology queries | Revalidate | "sphere-patch identity/seams" | Sphere halves stay unnamed when tied |
| K08 | Blend qualification | Partial | Resize-blend carries unique support identities | Re-blend makes "no output lineage claim" |
| K10 | Combination matrix | Planned | Oracle: "resolving references" in every cell | Plan: 20 cells lose seam fillet edges after a source edit |

## Notes by theme

### Lineage producer and its qualification (K05, K06, K08, K10, K01)

K05 ([ADR-013](../../adrs/ADR-013-persistent-topology-lineage.md),
[parameter replay](../../plans/parameter-reference-replay.md)) has shipped
pattern face/edge/vertex lineage, two-operand boolean evolution with an
on-demand probe, native-hole/offset/bore lineage, and suppression pass-through.
Its row still lists the October UX-1 finding: "a fillet or chamfer on a
sketch-extruded body stores hash-only edge references, so any later change
to that extrude or its sketch is refused". It also keeps persisted native
vertex references open. ADR-013 limits verified modification to plane and
cylinder carriers. It excludes vertices from the v5 contract and rejects
closed or unknown-closure B-spline faces. Partial revolves are hash-only by
the Z7 amendment.
The [kernel robustness plan](../../plans/kernel-robustness-plan-2026-11-05.md)
puts the remaining edge work in WS5 ("Stable edge identity through replay").
WS4 parametric-first routing "Depends on WS5". The two K05 fragments
([radius](../../roadmap-evidence/k05--cylinder-radius-across-boolean.md),
[routing](../../roadmap-evidence/k05--source-first-routing-across-boolean.md))
show that "a fillet or chamfer that holds a hash-only edge pick" stops that
routing. The K06 [sphere-patch fragment](../../roadmap-evidence/k06--sphere-patch-identity.md)
names hemispheres by pole and leaves ties unnamed. The K08
[WS6 fragment](../../roadmap-evidence/k08--ws6-remove-resize-reblend.md)
says its re-blend makes no output lineage claim, so faces re-resolve by
fingerprint.

### Caches and fences (H02, W02, D01)

H02's open work is publication equivalence. The raw B-rep matches, but
lineage publication drifted on cached paths. The
[H02 runtime record](../../qa/2026-10-21/h02-lineage-runtime-candidate.md)
fixed handle-derived keys (`blendRegionKey` now uses ADR-011 hashes).
W02/[ADR-015](../../adrs/ADR-015-bounded-exact-rebuild-cache.md) reuse a
suffix only when guarded by lineage. D01 uses a topology-hash fingerprint
fence and explicit Update instead of checkpoint replay
([drawing design](../../plans/drawing-mvp-design.md)).

### Sketch identity feeding model topology (S02, S04, S05, M01)

Region-extrude side walls are named from sketch object ids and segments
([direct-edit plan](../../plans/direct-edit-reliability-plan.md) B3). Sketch
entity identity therefore is topology identity downstream. The
[composite identity plan](../../plans/sketch-composite-identity-plan.md)
rejects implicit decomposition because "downstream references can retarget
or disappear". It treats a deleted and recreated object as a "Broken
reference until the user explicitly repairs it". The
[reference-dimension plan](../../plans/sketch-reference-dimensions-plan.md)
leaves legacy composite and datum consumers open.

### Face attachment and datum sources (S06, R01, U09, I05, M08, F01, I07, D04)

[ADR-014](../../adrs/ADR-014-true-face-attachment.md) resolves a sketch face
at its history position through the fail-closed resolver. It needs one planar
carrier. ADR-014 originally disabled Sketch on hash-only faces. The
direct-edit plan (B3) now places such sketches on a fixed coincident frame,
labelled with `UNSTABLE_FACE_SKETCH_REASON`, so they do not follow the face. ADR-014
states that "Full attachment coverage remains bounded by ADR-013 lineage
coverage". The ROADMAP baseline table says the same: "associative only within
the verified lineage subset". The
[datum plan](../../plans/datum-geometry-plan.md) lists hash-only, mesh,
non-planar and unqualified sources as unavailable and adds that "R01 does not
claim to finish K05". F01's [qualification](../../plans/f01-through-all-qualification.md)
uses the same face-source shape, and its row adds that topology-dependent
conditions "require K05's verified references".

### Edge sets and direct edits (M02, M03, M05, M07, M14, F03, U01, U03, H03)

Every fillet and chamfer stores an edge set, so these rows inherit K05's
edge gaps. The [imported-edit plan](../../plans/imported-step-feature-edit-plan.md)
keeps freeform blend bands read-only and sphere face picks unavailable. The
[M07 fragment](../../roadmap-evidence/m07--rotational-direct-edits.md) now
consumes verified construction history "instead of dropping the persistent face
references". "changes requiring a different adjacency graph still refuse".
Gears (M14) are the clearest positive case: kernel face roles are named so
that downstream fillets and holes survive edits.

### Drawings (D02, D03, D05, D06)

The [drawing design](../../plans/drawing-mvp-design.md) resolves edges
"lineage first, then hash, failing on zero or several matches", never by
nearest edge. Section cut edges "have new hashes and no lineage name", so a
moved floor breaks its dimension. The
[auto-dimensioning plan](../../plans/drawing-auto-dimensioning-plan.md) holds
faces through `resolveFace` and notes "Revolved faces are currently
hash-only". The [D02 fragment](../../roadmap-evidence/d02--delete-broken-annotations.md)
adds bulk deletion of broken annotations, not rebinding.

### Assemblies (AS01, AS02, AS05)

Per the [assemblies plan](../../plans/assemblies-plan.md), joint frames "are
stored as numbers with their picked source; re-resolving them after a body is
reshaped is a follow-up (today the stored frame is kept)". The
[AS01 fragment](../../roadmap-evidence/as01--assembly-components.md) binds
components to body lineage. The
[AS02 fragment](../../roadmap-evidence/as02--typed-joints-drag.md) builds joints
on "picked frames". AS05 carries cross-part references and is deferred behind
K05 and I01.

## Cross-cutting observations

- **One policy, many rows.** R01, I01, D02, D03, U06, S04, the datum plan,
  ADR-014 and K05 all repeat fail-closed, no-proximity resolution with explicit
  re-pick. The limitation users see is therefore always "broken, re-pick". U06's
  open uniform re-pick affordance is a shared dependency, not a polish item.
- **Edge lineage is the most common blocker.** K05's open edge classes
  (multi-operand booleans, chamfer, shell/offset, direct edits, STEP
  provenance) and the region-extrude hash-only edges (UX-1) limit M02, M03, F03
  and U03 (edge sets), D02/D03/D06 (dimensions), M11 (kept-body evolution) and
  K10 (20 WS5 cells). The kernel robustness WS4 routing also waits on them.
- **Eleven rows name K05 as a dependency** (AS05, F01, H03, I01, K10, M02,
  M05, M07, M11, M14, R01); M08, M10, S02 and AS02 inherit it through R01.
- **Vertex identity is missing.** ADR-013 excludes vertices, and K05's native
  vertex names are runtime-only. R01 works around this through edge ends. M03
  per-vertex controls, S08 guidepoints and AS02 frames have no persisted
  vertex reference to use.
- **Hash-only islands keep coming back:** partial revolve (ADR-013 Z7, D06
  revolved faces), drafted extrude (F01), section cut edges (D03), re-blend and
  direct-edit output (K08, ADR-013 table), and freeform/closed B-spline faces.
  Each one forces a fixed-frame or broken-reference fallback downstream.
- **Planar or analytic only.** Face attachment, to-face targets, datum face
  sources and modified-face verification all accept planes, plus cylinders for
  modification. Curved or slanted targets (F01's open to-face cases, M12 wrap) wait on
  wider witness classes.
- **Some persisted geometry is not re-resolved at all.** AS02 frames
  (numbers), I05 images on identity-less faces (fixed frame) and D01 sheets
  (fingerprint fence) record snapshots, so they do not follow topology. These
  are deliberate stopgaps that need the same naming answer later.
- **Determinism and cost are part of naming.** H02 shows that lineage
  publication must match across cached and cold paths. The baseline table
  records that the boolean probe "doubles boolean rebuild cost (measured
  2.03×)", which is why K05 and D01 request that lineage only on demand.
- **Units touch identity.** ADR-013 quantizes witnesses in document units, so
  I03 whole-document unit conversion must migrate stored witnesses and hashes.
  This is an inference from the ADR; the row says only "persisted references".
