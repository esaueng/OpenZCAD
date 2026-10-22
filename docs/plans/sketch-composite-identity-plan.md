# S04: Constraint-capable composite sketch identity

Status: **implemented for new drawings by the decision below (schema v26).**
The original proposal below is retained as history and as the design for
legacy parametric objects. S04-B defines named targets for new held-line
shapes; S04-C adds explicit legacy conversion and authored boundary provenance.

Baseline: OpenZCAD `main` at `efa2662910199e6d23d63f337e35d3d591614d21`.

## Decision (October 2026): new drawings are held lines

The owner chose the alternative this proposal rejected as a default:
**decompose at creation, for new drawings only.** The viewport's Rectangle
tool (corner, centre and three-point types) and the new Polygon tool draw
real `line` objects held by ordinary persisted relations, and one additive
`SketchNode.composites` record names those lines as one object. Every
rectangle or polygon object already stored keeps loading as the parametric
object it is; nothing is rewritten on load, and nothing converts an old
object.

Why the rejection no longer holds:

* **The rejection's cost was a legacy cost.** The table below rejects
  decomposition because it "changes object IDs, region source IDs, history
  shape … It makes opening an old document equivalent to an unrequested
  edit." All of that is about converting saved objects. A new drawing has no
  prior IDs, regions or history to change.
* **A three-point rectangle cannot be a parametric rectangle.** The
  `rectangle` object is axis-aligned (`width`, `height`, `centerX`,
  `centerY`) and this proposal makes any rotation a named refusal. Holding a
  rotated rectangle needed either a new rotation field plus the virtual
  solver bridge, or lines.
* **Lines get the whole sketch toolkit now.** Held lines solve on the
  existing GCS, take every existing relation and dimension at their corners
  and sides, and work with Trim, Fillet, Chamfer, Offset, Mirror and the
  patterns, which refuse composite objects by name. The virtual-graph bridge
  this proposal designs would have taken several slices to reach a subset of
  that.

What the record carries (`SketchComposite`, `packages/shared`):

* `compositeId` (`scmp_…`), `compositeKind` (`rectangle` | `polygon`) and
  `method` (`corner` | `center` | `three-point` for rectangles, `inscribed`
  for polygons).
* `edgeIds`: side `i` runs from corner `i` to corner `i + 1`,
  counter-clockwise. Corner `i` is the start of side `i`, held to the end of
  side `i - 1` by a coincident relation. Corner and side identity is an index
  into this list, never a coordinate.
* `helperIds`: owned construction geometry. These are a centre rectangle's two
  diagonals (their crossing is the centre) and a polygon's circumcircle.

The relations each tool writes are proved independent on the pinned kernel,
so none is reported redundant. Each leaves exactly the shape's own freedom:

| Tool | Relations | Freedom left |
| --- | --- | --- |
| Corner / centre rectangle | 4 corner coincidents; sides 0, 2 horizontal and 1, 3 vertical; centre type adds 4 diagonal-end coincidents | 4 (position, size) |
| Three-point rectangle | 4 corner coincidents; side 1 perpendicular to side 0; both opposite pairs parallel | 5 (adds rotation) |
| Inscribed polygon | n corner coincidents; every vertex on the construction circumcircle; every side equal to side 0 | 4 (centre, circumradius, rotation) |

The rules:

* **One transaction.** Sides, helpers, relations and the record commit
  together with pre-assigned IDs, so one undo removes the shape and redo or
  replay restores the same IDs.
* **Deleting a member dissolves the record.** The other lines and their
  surviving relations stay as ordinary geometry; undo restores the record.
  An edit that opens the loop leaves the record in place, and the shared
  resolver then reports it as broken by name. It never guesses.
* **Resize is one object edit.** Selecting a side opens the shape's card:
  width and height, or circumradius. It moves every side and helper in one
  edit, solved together with the sketch's relations. A centre rectangle
  keeps its centre, a polygon keeps its centre and rotation, and the others
  keep corner 1.
* **Not geometry.** The record never enters the solver or the exact-history
  digest. The lines and relations are the geometry.
* **Schema v26.** The bump stops an older client from silently dropping the
  record on save. `normalizeDocument` validates the record's shape and never
  synthesizes one.

The next section delivers corner and side snap or reference-dimension targets
for these held-line composites. Region-provenance tokens and the explicit
conversion command for the **legacy** parametric objects are delivered by
S04-C below. Untouched legacy objects keep their original representation.

## Composite target identity (S04-B)

This bounded slice builds on the held-line decision above and on S02-E in
[PR #797](https://github.com/esaueng/OpenZCAD/pull/797). It uses additive schema
v36 from that branch's v35 baseline; earlier coordinated schema migrations must
be reconciled against the actual merged base before integration.

A saved corner or side target names its composite ID, a zero-based index, and
an immutable version-1 snapshot of the complete ordered side and helper IDs.
Identity contains no coordinates. Indices must be finite integers in range;
constructors and resolvers never wrap them. The current record must have the
same ordered members, and the complete shape must resolve before any corner
or side is published. Missing owners, changed topology, broken loops, missing
helpers and changed helper ownership produce a named unresolved reference.
No primitive, array-order or nearest-geometry fallback repairs one silently.

Reference distances accept primitive points and composite corners; reference
angles accept primitive lines and composite sides, including mixed targets.
The palette and snapping expose human-readable corner/side names. Driving
relations retain their existing real line/endpoint aliases and solver inputs.
The same physical target selected through two aliases is refused as the same
target. Absolute, horizontal and vertical reference modes keep their S02-E
semantics along the sketch's axes; annotation identity, placements and targets
survive resize, replay, undo/redo, backup and reopen.

Deleting any side or helper would dissolve a named composite, so a saved
composite-target annotation blocks that deletion until it is explicitly
removed. Unrelated primitive reference/deletion behavior remains unchanged.
Malformed descriptors are refused on load, including undo/redo nodes; a
well-formed target whose topology no longer resolves stays visible and
removable. Schema versions before v36 cannot carry composite-target records. An omitted
schema version is not proof that these targets are supported.
Legacy saves without them remain additive and do not synthesize descriptors.

Acceptance covers rectangle methods and regular polygons, strict topology and
ownership validation, reversed/reordered/replaced members, broken geometry,
primitive/composite alias collisions, deletion and recovery, mixed and
projected measurements, and saved command replay. Exact-kernel regressions
must show unchanged geometry/solve inputs and cache keys for annotation-only
edits, and analytic downstream extrusion results after resizing the real
lines. Browser coverage must exercise creation, read-only activation, target
retention, undo/reopen and compact controls.

This slice does not add legacy parametric-object conversion, virtual solver
geometry, datum targets, composite centers or legacy region-provenance tokens.
The existing held lines remain the source of exact regions and lineage.

## Legacy provenance and explicit conversion (S04-C)

This implementation builds on [S04-B #800](https://github.com/esaueng/OpenZCAD/pull/800)
and uses schema v37 from its v36 baseline. Independent pending schema changes
must be reconciled with the actual merged base. This section supersedes the
historical virtual-graph and promotion recipes below; it uses persisted legal
primitive constraints, with no virtual solver operands.

Conversion retains authored unit-aware source expressions. When generated
coordinates combine a bare document-unit center with an explicit length or
typed length parameter, each operand is expressed in document units before
the affine sum. The generated edges remain live parameter expressions; no
source witness, identity matcher or geometric tolerance is rewritten to make
mixed-unit input fit.

When linked projection constraints move neighboring geometry, conversion uses
the project/version-qualified exact read view for profile qualification while
keeping canonical authored expressions as the mutation base. A versioned optional
`qualification` command payload stores changed numeric analysis geometry and a
stable authored-input digest so full replay does not need transient kernel
state. Projection verdicts must be current or moved at live preparation.
Overrides never become neighboring authored values, and the unchanged profile
resolver still rejects altered loop roles, hole multiplicity and boundary tokens.
Native-copy project identity and artifact locations are excluded from the
content digest; source checksums and actual modeling inputs remain included.
The digest detects stale input and does not authenticate fabricated coordinates.

Legacy rectangle/polygon arrangement curves now carry the fixed
`b1/<entity>/<rectangle|regular-polygon>/1/<count>/e/<index>` token. Indices are
zero-based, including zero; noncanonical decimals, unknown versions and
invalid counts refuse. Mixed boundaries also carry
`p1/<entity>/<line|circle|arc|ellipse|spline>` tokens for primitive curves.
Every derived curve contributes one token. Outer and hole roles, cyclic order,
reversal equivalence and repeated split-edge occurrences are preserved; holes
form a sorted multiset of canonical loops. A profile carries
`sourceBoundaryLoops` only when at least one legacy or promoted curve contributes.
Primitive-only selections retain their earlier saved shape.

References with this witness resolve only through exact loop provenance.
Geometry may distinguish multiple exact topology matches, with a finite area
and interior sample witness; it cannot repair a topology mismatch. Existing
references without the field keep their previous resolver tiers. UI picks,
re-picks, modeling operations and AI-created profile selections share this
rule. Adding metadata does not change curve geometry, fingerprints or profile
IDs, and loading old documents synthesizes no saved provenance.

**Convert to editable edges** is explicit, available on an unchanged committed
legacy rectangle or regular polygon. One replay command preassigns generated
identities, validates every source parameter and replaces the object atomically.
The promotion witness retains its prior raw parameters, construction state and
name, ordered edges, a construction center spoke, owned structure IDs and a
versioned map of vertex/edge/center aliases. Rectangle conversion adds one
construction diagonal so the spoke's start remains the center under edits.

The rectangle graph uses corner coincidents and H/V sides, raw width/height
distances, diagonal endpoint coincidences and a midpoint relation for the
center. Opposite-side equalities in the original recipe are omitted because
they are redundant on a closed H/V rectangle. Polygons use corner coincidences,
equal sides, raw radius distances from the center and a vertical center spoke
to preserve the top-first phase. These graphs are independent on the pinned
GCS. Coordinate expressions retain source parameter reads; dimensional values
retain raw width/height/radius expressions. Existing legal user constraints
retain their IDs, values and order. Unsupported saved legacy operands refuse
before mutation rather than being dropped or guessed.

Affected bounded downstream selections gain their precise old loop witness
only during this conversion. Their aliases resolve to the generated lines;
source-derived side/cap lineage remains available for attachments. A bounded
selection is never widened to `all: true`. An older reference already authored
with `all: true` retains that explicit entity-wide intent by remapping the
source ID to its ordered generated edges. Malformed, ambiguous or incomplete
aliases refuse. Typed boundary dependents protect source topology and member
deletion; releasing structure does not discard aliases.

Generated structure is hidden from ordinary relation and dimension controls,
but remains present for solving, ownership checks and diagnostics. The separate
**Release shape constraints** command removes only that owned structure while
retaining user constraints and the promotion aliases, allowing deliberate free
edge editing. Neither an edit nor a constraint request releases it implicitly.
Deleting an unconsumed member dissolves its promotion and all owned structure;
with downstream dependents it refuses. Undo restores the exact prior graph,
source, aliases and references; redo/replay reuses every recorded identity.

Schema validation covers current, readable undo/redo and replay-only profile,
alias and ownership records, including nested transactions and saved log copies.
Pre-v37 and unversioned carriers refuse these new fields; unreadable undo history retains the
existing recovery policy. Exact tests qualify analytic solids, independent
solver graphs and attached faces through conversion, resizing, replay and
backup. Browser tests cover both shapes, refusal without a history edit,
release/free editing, undo/reopen and compact controls. `ROADMAP.md` remains
the only delivery ledger.

## Decision summary (original proposal)

Keep `rectangle` and `polygon` as authored parametric sketch objects and give
their derived corners and edges stable, typed identities. Do not silently
replace either object with line entities. The first implementation may lower a
composite to a temporary line graph for solving, but it must write back only
solutions that still fit the object's authored parameterization.

An explicit **Convert to editable edges** command is the escape hatch for a
free-form corner edit or a constraint that cannot be represented by the
primitive. That command is a later, separate slice. It is atomic, undoable, and
persists a mapping from the old composite references to the new line graph. A
constraint request never performs this conversion as a side effect.

This choice preserves the current document and region contracts while making
the common rectangle and regular-polygon references durable. It also gives the
solver and UI one place to report the boundary between a constrained primitive
and a genuinely free-form profile.

## Current contract and the problem

The current `SketchObjectData` stores rectangles as `width`, `height`,
`centerX`, and `centerY`, and regular polygons as `sides`, `radius`, `centerX`,
and `centerY` ([`packages/shared/src/index.ts`](../../packages/shared/src/index.ts)).
The generated polyline order is already deterministic: rectangles are
bottom-left, bottom-right, top-right, top-left; polygons start at the top and
advance counter-clockwise ([`apps/web/src/lib/objectPolyline.ts`](../../apps/web/src/lib/objectPolyline.ts),
[`packages/geometry/src/regions.ts`](../../packages/geometry/src/regions.ts)).
That order is useful evidence, but it is currently an implementation detail,
not a persisted reference contract.

The constraint schema accepts point refs (`start`, `end`, `center`) and whole
line/circle/arc object IDs. `rectangle`, `polygon`, and `text` are deliberately
rejected because they are one parametric node with no point identity
([`packages/document-core/src/index.ts`](../../packages/document-core/src/index.ts),
[`apps/web/src/lib/sketch/constraints.ts`](../../apps/web/src/lib/sketch/constraints.ts)).
The existing refusal is correct for arbitrary corner motion; S04 must replace
it with a narrower, explicit contract rather than make a derived coordinate
look like a free point.

Regions currently expand a rectangle or polygon into segments whose
`sourceObjectId` is the composite object's ID. A selected extrusion stores
`profileId`, fingerprint, area, sample point, and optional source entity IDs
([`packages/geometry/src/regions.ts`](../../packages/geometry/src/regions.ts),
[`packages/shared/src/index.ts`](../../packages/shared/src/index.ts)). The
resolver first uses exact identity, then a unique source-entity set, and
otherwise refuses ambiguity ([`packages/kernel-adapter/src/region-profile.ts`](../../packages/kernel-adapter/src/region-profile.ts)).
S04 must retain those legacy paths and add precision for new composite
boundary references without changing the meaning of an old save.

## Alternatives considered

| Option | Benefit | Cost and failure mode | Decision |
| --- | --- | --- | --- |
| Decompose every rectangle/polygon into line nodes at creation | Reuses the existing solver and point refs immediately | Changes object IDs, region source IDs, history shape, selection/editor behavior, and saved profile identity. It makes opening an old document equivalent to an unrequested edit. | Reject as the default |
| Decompose only when a constraint is first requested | Supports arbitrary corner edits | Still silently changes the authored feature at the moment of a pick; downstream references can retarget or disappear unless a durable alias graph is added. | Reject as an implicit action |
| Give the composite stable corner/edge refs and lower to a virtual graph | Preserves authored identity and current UI/region contracts; supports constraints that fit the primitive | Requires a solver adapter and an explicit refusal for underivable free-form edits. | Recommend |
| Stable refs plus an explicit conversion command | Handles the full free-form case while keeping conversion visible and undoable | Conversion and old-reference rebinding are a larger follow-up slice. | Recommend as the escape hatch |

The recommended pair separates two meanings that must not be conflated:
“the top-right corner of this still-rectangular feature” is a stable semantic
reference; “move this one corner independently” is a request to change the
feature type and needs an explicit conversion.

## Proposed identity contract

### Composite topology descriptor

Each supported composite object has a derived topology descriptor. It is not a
hash of coordinates and is not a render-object ID.

```ts
type CompositeTopology =
  | { kind: 'rectangle'; version: 1; vertexCount: 4; edgeCount: 4 }
  | { kind: 'regular-polygon'; version: 1; vertexCount: number; edgeCount: number };
```

The descriptor is derived from the object kind and resolved `sides` value. A
future object kind or polygon orientation must use a new descriptor version;
it must not reuse these tokens with a different ordering.

### Point and curve references

Keep all existing serialized primitive refs valid. Add tagged composite refs so
the parser cannot mistake an edge address for a whole object ID.

```ts
type CompositePointRef = {
  kind: 'composite-point';
  objectId: EntityId;
  topology: CompositeTopology;
  point: 'center' | 'vertex';
  index?: number; // required for vertex; absent for center
};

type CompositeEdgeRef = {
  kind: 'composite-edge';
  objectId: EntityId;
  topology: CompositeTopology;
  edgeIndex: number;
};

/** Existing entity IDs remain the serialized form for primitive operands. */
type SketchCurveRef = EntityId | CompositeEdgeRef;
```

The eventual shared constraint types should make `SketchPointRef` a backward
compatible union of its current primitive form and `CompositePointRef`.
Every constraint operand must use the union appropriate to its existing kernel
meaning. The implementation must not add a second ad-hoc edge field to only
one constraint kind:

| Constraint kind | Operand contract after S04 | Composite form supported in the first slice |
| --- | --- | --- |
| `coincident` | `SketchPointRef × SketchPointRef` | composite vertex or center; primitive endpoints/centers remain valid |
| `horizontal`, `vertical` | one `SketchCurveRef` | composite edge; regular-polygon edge is structural unless its direction is already canonical |
| `parallel`, `perpendicular` | `SketchCurveRef × SketchCurveRef` | rectangle edges and compatible composite/primitive line pairs |
| `equal` | `SketchCurveRef × SketchCurveRef` | line-like pairs, including rectangle edges; circle/arc radius pairs keep their existing entity form |
| `tangent` | `SketchCurveRef × SketchCurveRef`, with `at?: SketchPointRef` only for an arc side | composite edge ↔ circle/arc; edge ↔ edge remains refused as it is today |
| `concentric` | existing circle/arc entity operands | no composite edge; a polygon/rectangle is not a circle or arc |
| `midpoint` | `SketchPointRef` plus `SketchCurveRef` | composite edge target; the point may be a composite vertex/center |
| `distance` | `SketchPointRef × SketchPointRef` plus `ParamValue` | composite vertex/center; raw expression remains persisted |
| `radius` | existing circle/arc entity plus `ParamValue` | no composite edge; composite radius is a parameter edit, not a radius constraint on a line |
| `angle` | `SketchCurveRef × SketchCurveRef` plus `ParamValue` | rectangle edges and compatible primitive/composite line pairs |

`EntityId` in the table means the current primitive form, not a string alias for
a composite edge. A shared helper such as `resolveSketchCurveRef` must return
a normalized line/circle/arc handle plus its source identity. It validates the
tagged topology descriptor before the GCS layer sees the operand. The GCS
translator then uses that helper for every row above; it may refuse a valid
structural type combination when the authored composite cannot represent the
result, but it must never silently discard the constraint.

Deleting an object calls one recursive `constraintReferencesObject` helper
over every operand: strings, `CompositePointRef`, `CompositeEdgeRef`, and an
arc's optional `at` point. That helper feeds both document-core deletion and
the selection/dependency UI. Deleting a composite removes all constraints
that mention its point, edge, or center, under their existing constraint IDs;
undo restores the exact records. A topology change leaves those records
present only when the update is rejected atomically (the side-count rule below)
or when a future explicit repair command has taken ownership; it does not
silently filter them.

Canonical addresses are:

* Rectangle vertices `0..3` use the existing generated order: bottom-left,
  bottom-right, top-right, top-left. Edges `0..3` join each vertex to the next.
* Regular-polygon vertices `0..sides-1` use the existing top-first,
  counter-clockwise order. Edge `i` joins vertex `i` to `(i + 1) % sides`.
* `center` is a stable semantic point for both composites. It is the center
  parameter, not a generated vertex and not a coordinate-selected point.

A resolver must check the object ID, descriptor version, object kind, index
range, and expected vertex/edge count before returning geometry. It must never
choose the nearest current corner. A missing object, changed kind, changed
polygon side count, or unknown descriptor is a named broken reference.

The references contain no resolved coordinates. This is what lets a width,
height, center, or radius edit preserve identity while still allowing the
geometry to move.

### Deterministic solve lowering and write-back

For one solve, the adapter constructs a deterministic `ObjectHandles` entry
for every authored object in `sketch.objectIds` order. A composite entry owns
virtual point handles for its center and vertices, and virtual line handles for
its edges. The handle map is rebuilt for every call and is never persisted.
Each handle stores the source object ID, topology descriptor, role/index, and
the canonical parameter map used to derive it. Every document constraint gets
one kernel constraint handle in declaration order, as the current
[`gcs-sketch.ts`](../../packages/kernel-adapter/src/gcs-sketch.ts) contract
already requires for residual attribution.

The virtual points and lines are not independent GCS bodies. A dedicated
composite solve path keeps one canonical parameter vector per object and adds
the following structural equations before translating user constraints:

* A rectangle derives its points from
  `p0=(cx-w/2,cy-h/2)`, `p1=(cx+w/2,cy-h/2)`,
  `p2=(cx+w/2,cy+h/2)`, and `p3=(cx-w/2,cy+h/2)`. The four edge vectors,
  closure, and `w > 0`, `h > 0` are structural residuals, so horizontal,
  vertical, opposite-edge, and corner relationships cannot free a virtual
  corner independently.
* A regular polygon derives `pi` from `(centerX, centerY, radius)` and its
  fixed top-first phase. Equal edge lengths, equal radial distances to the
  center, closure, and `radius > 0` are structural residuals. There is no
  rotation residual because rotation is not a persisted polygon parameter;
  any requested rotation is a named refusal.

Structural residuals are adapter-owned and are not persisted as user
constraints. User constraints remain one-for-one with kernel handles and
residual attribution. The solve report exposes `structuralResiduals` and a
rank-based `freeDof` count for diagnostics: rectangle DOF starts at four and
regular-polygon DOF starts at three, then independent user equations reduce
that count. A nonzero `freeDof` is not by itself a refusal. The solver keeps
the prior canonical values as the deterministic seed for unconstrained
parameters and commits when all structural and user residuals satisfy
tolerance and the inverse representation is unique. It refuses only when a
changed result is inconsistent, non-converged, or cannot be represented by
the canonical fields. This prevents an otherwise valid rectangle with only a
horizontal edge constraint from being rejected as an immediately
under-constrained free-line graph.

The inverse map is deliberately stricter than the forward lowering:

* A rectangle candidate is calculated from its four canonical vertices as one
  parameter tuple `(centerX, centerY, width, height)`. The adapter computes the
  center from the mean of opposite corners and the width/height from the
  canonical opposing edge projections, then regenerates all four expected
  vertices. It accepts the tuple only when every solved vertex matches its
  generated counterpart within the solve tolerance, width and height are
  positive, and the axis-aligned orientation is unchanged. It never averages
  an inconsistent graph into a rectangle.
* A regular-polygon candidate is calculated from its fixed `vertexCount` as
  `(centerX, centerY, radius)` using the vertex centroid and mean radial length.
  The adapter regenerates every top-first, counter-clockwise vertex and checks
  the phase, radius, and residual. A solved rotation cannot be written because
  the current polygon schema has no rotation field; it is a named refusal or
  an explicit future schema change.
* A composite solve is committed only when the structural path converged, did
  not roll back, and the inverse fit is unique. An under-constrained result
  with unchanged seeded canonical values may commit the user constraint
  records without moving the composite; an under-constrained result that
  proposes changed geometry refuses rather than choosing an arbitrary GCS
  position. Redundant or unsatisfied results follow the current refusal path.

The write-back command stores only canonical composite fields. It must capture
the raw `ParamValue` fields before solving and apply this expression policy:

1. An unchanged field keeps its original number or expression string verbatim.
2. A changed numeric literal may be replaced by the fitted number.
3. A changed expression-backed field is an expression conflict and refuses the
   transaction with a repair message naming the field and parameter. S04 does
   not silently de-parameterize a composite to make a solve pass.
4. Constraint values, including distance/angle expressions, remain their raw
   `ParamValue`; only the parameter table or an explicit expression edit may
   change them.

This is intentionally stricter than the generic primitive write-back helper's
legacy behavior for a moved expression field. A later shared solver policy may
relax it only with an explicit design decision and equivalent replay proof.

## What the first solver slice supports

The virtual graph is a derived view, not a second persisted sketch. It exposes
the canonical points and line segments above to the existing constraint
pipeline. The adapter then maps a successful solve back to the composite's
parameters and rejects a solve that cannot be represented by them.

For rectangles, the representable set is:

* horizontal/vertical on any edge;
* parallel/perpendicular/equal between edges and compatible line operands;
* distance between any two composite points, or between a composite point and
  an existing point, when the result can be expressed by `centerX`, `centerY`,
  `width`, and `height`;
* midpoint and coincident constraints involving a composite point when the
  resulting rectangle remains axis-aligned; and
* existing width/height/center parameter edits, with the same constraint solve
  and refusal path as other sketch edits.

For regular polygons, the first slice supports:

* center/radius-compatible distance constraints;
* coincident or midpoint constraints that move the center while preserving a
  regular polygon; and
* structural edge constraints that are already implied by the regular
  polygon's side count and orientation.

An edge constraint that would require changing a regular polygon into an
arbitrary polygon, or a rectangle corner constraint that requires independent
corner motion, is refused with an action such as “This edit needs independent
edges. Convert the rectangle to editable edges first.” The refusal must leave
the last valid geometry and history unchanged. It must not create hidden line
nodes, rewrite the object kind, or weaken solver tolerances.

The first slice should not pretend that every mathematically expressible
constraint has a representable parameter solution. The acceptance boundary is
the authored parameterization, not whether a temporary graph can produce
coordinates.

## Region identity and downstream replay

The region engine should retain `sourceEntityIds` exactly as it is today and
add optional boundary provenance for new composite-aware profiles. The token
wire format is fixed for this design so matching cannot drift between the
geometry and kernel packages:

```text
boundary-token = "b1/" entity-id "/" topology-kind "/" version "/" count "/e/" edge-index
entity-id     = 1*(ALPHA / DIGIT / "_" / "-")
topology-kind = "rectangle" / "regular-polygon"
version       = 1*DIGIT
count         = 1*DIGIT
edge-index    = 1*DIGIT
```

`entity-id` matches the repository's `prefix_UUID` IDs. `count` is `4` for a
rectangle and the resolved side count for a regular polygon. For example,
`b1/ent_123e4567-e89b-12d3-a456-426614174000/rectangle/1/4/e/2` and
`b1/ent_123e4567-e89b-12d3-a456-426614174000/regular-polygon/1/6/e/4` are valid. A token parser rejects
unknown versions, out-of-range indices, malformed IDs, and extra fields;
it does not normalize an unknown token into a near match. Primitive line and
arc provenance continues to use existing `sourceEntityIds`; S04 tokens are
only emitted for the rectangle/polygon boundaries they describe.

Each generated arrangement curve carries its token as provenance. The profile
stores provenance by loop, not as a flat set:

```ts
type BoundaryProvenance = {
  outer: string[];   // one token per derived boundary curve, in loop order
  holes: string[][]; // each inner loop separately, in loop order
};
```

The arrays are a **sequence-aware multiset**: repeated tokens are retained,
outer and hole roles are distinct, and holes are sorted by their canonical
loop serialization. A source edge split into three arrangement segments
therefore contributes that token three times. A plain `Set` is forbidden: it
would erase split-edge multiplicity and could make two different regions look
identical. `SketchProfile` and new `SketchRegionProfileReference` values carry
this optional `sourceBoundaryLoops` value. Legacy references remain unchanged
and do not acquire synthetic provenance on load.

New resolution order:

1. A reference with `sourceBoundaryLoops` validates every token, then compares
   the canonical outer-loop sequence and the multiset of canonical hole-loop
   sequences, including occurrence counts. Reversing traversal is normalized
   by choosing the lexicographically smaller rotation of the forward and
   reversed sequence; outer and hole roles are never merged.
2. If exactly one current profile matches that provenance and its topology
   descriptors are valid, changed dimensions are accepted and the profile's
   geometry-derived fingerprint/area are refreshed for the rebuild.
3. If a source edge has been split into several candidate cells, strict loop
   matching may leave several candidates. The resolver may use the stored
   sample point and area only among candidates with the exact same token
   multiplicities. It must refuse when the sample/area witness is outside,
   non-finite, or still ambiguous; it must not pick by array order or nearest
   geometry. A crossing that changes one source edge from two arrangement
   segments to one or three changes the repeated-token count and is a
   topology/provenance mismatch: it refuses before sample/area fallback. S04
   never normalizes split counts or silently remaps them.
4. A reference without boundary provenance follows the existing `profileId`,
   source-entity, and legacy geometric fallback tiers exactly as before.

This preserves the existing rectangle-extrude behavior proved by
[`test/region-extrude-lineage.test.ts`](../../test/region-extrude-lineage.test.ts):
resizing a rectangle changes the face hash but keeps the source lineage name.
New boundary tokens make the source edge explicit; they do not claim that a
source edge split into multiple derived faces has one-to-one identity. The
per-curve repeated token and loop-role comparison preserve that uncertainty;
a split that cannot be uniquely resolved remains a refusal. Boundary tokens
are provenance of authored sketch curves, not exact kernel edge IDs, and are
never used to name a preview mesh or a tessellation segment.

`{ all: true, sourceEntityIds }` remains reserved for entity-wide outline
providers such as text. Rectangles and polygons must never be converted to
`all: true`, because that would silently select every region produced by a
composite and could change an extrusion's material intent.

### Explicit conversion mapping

The later conversion command must persist a promotion record containing:

* the source composite entity ID and topology descriptor;
* the generated line entity IDs and endpoint mapping for every old vertex and
  edge token. The canonical mapping is vertex `i` → `start` of generated edge
  `i`, and edge `i` → generated line entity `i`;
* one generated `construction: true` center-spoke line per promoted composite.
  Its `start` is the old center point and its `end` is vertex `0`, so a center
  constraint has an existing persisted point representation without inventing
  a new point object kind;
* the source object’s prior parameters and construction/contributing state;
  and
* a versioned alias map used by profile and attachment resolvers.

The conversion also writes only existing legal constraint payloads as
system-owned promotion constraints. For a rectangle, it writes coincident
constraints for adjacent endpoints, `horizontal` for edges `0` and `2`,
`vertical` for edges `1` and `3`, and `equal` for the two opposite-edge
pairs. For a regular polygon, it writes coincident constraints for adjacent
endpoints, `equal` between edge `0` and every other edge, `vertical` on the
construction center spoke to preserve the top-first phase, and one `distance`
constraint from the spoke's `start` (the center) to each generated vertex.
Each polygon distance uses the source radius `ParamValue` verbatim. This is
the persisted radial relationship; S04 does not invent a `radial` constraint
kind. The spoke is construction geometry owned by the promotion record, and
its generated ID, endpoint ownership, and system constraint IDs are replayed
and deleted with that record.

The system IDs are derived from the promotion ID and canonical index and are
distinct from user constraint IDs. If the coordinated schema cannot yet carry
the additive `origin: 'promotion-structure'` marker below, promotion is
deferred as unsupported; it must not write unowned structural records.

The constraint schema needs an additive `origin?: 'user' | 'promotion-structure'`
marker so structural records can be hidden from the ordinary user list while
remaining visible to deletion, replay, and diagnostics. An absent marker is
interpreted as `user` for older documents.

Before replacing the composite, the command rewrites each existing constraint
operand through the alias map while preserving its `constraintId`, kind, raw
`ParamValue`, and declaration order:

User records remain first in their original order. Generated structural
records are appended in canonical edge order, so serialized order is stable
across save/reopen and redo.

* a composite vertex maps to the mapped edge endpoint;
* a composite edge maps to the generated line entity;
* a composite center maps to the center-spoke `start` endpoint; and
* a primitive operand or an unrelated point is copied unchanged.

If any operand lacks a complete alias, or if a constraint combination cannot
be expressed by the generated line graph, promotion refuses before changing
the document. It never drops a constraint merely because it is inconvenient
to map. The source composite remains available as a non-contributing history
witness only when the promotion record says so; otherwise its replacement and
the alias map are one transaction. The region resolver may follow the alias
map from an old composite boundary token to its promoted line entities, but it
must refuse if the map is missing, ambiguous, or partially deleted.

Undo restores the original composite node, its exact pre-promotion constraint
array and downstream references, removing generated line/system-constraint
nodes. Redo reuses the recorded generated IDs, user constraint IDs, system
constraint IDs, and alias map; it does not allocate a new graph or reorder
constraints. Save/reopen serializes that same promotion record before replay.
The conversion is a separate implementation slice; S04's initial stable-ref
work must not invent a partial conversion.

## Upstream edits and deletion rules

| Upstream change | Constraint refs | Region/downstream refs | Required result |
| --- | --- | --- | --- |
| Rectangle width, height, or center changes | Same tokens; virtual points move | Same boundary tokens; recompute fingerprints and exact geometry | Commit and replay normally |
| Polygon radius or center changes | Same tokens while `sides` is unchanged | Same boundary tokens; recompute geometry | Commit and replay normally |
| Polygon `sides` changes | **Atomic refusal when any typed point/edge reference resolves to the polygon** | **Atomic refusal when any boundary-aware `sourceBoundaryLoops` reference names the polygon**; v15 geometry-only refs retain their existing resolver behavior | No document mutation, no stale constraint state, and an actionable “remove/repair the reference or convert to editable edges” diagnostic |
| Composite object kind changes | Existing composite refs no longer validate | Old source tokens do not match the new kind | Refuse when referenced, or require an explicit conversion command; never reinterpret an index |
| Composite is deleted | References cannot resolve | Load-bearing downstream deletion policy applies | Delete is refused or presents the existing dependent-delete flow; no dangling ref is saved |
| Object is deleted and recreated with a new ID | Old refs do not match | Old profiles do not rebind by geometry | Broken reference until the user explicitly repairs it |
| A different entity changes an authored edge's split count | Repeated token multiplicity no longer matches | Boundary provenance is a topology mismatch | Refuse before sample/area fallback; never normalize `2` segments to `1` or `3` |

Parameter edits that preserve topology must never delete constraints. A kind or
topology change may leave a diagnostic-bearing stale constraint for repair, or
be refused before commit, but it must not silently drop the user's design
intent. Deleting the source object follows the existing document-core rule
that constraints attached to a deleted object go with that object; undo must
restore them under their original IDs.

The polygon side-count rule is deliberately one behavior rather than a mixed
“sometimes stale, sometimes committed” policy: every path that can change
`sides`—direct parameter editing, expression evaluation, `updateSketchObject`,
solver write-back, redo, and replay—must call the same preflight before it
evaluates or mutates the candidate. The preflight scans all typed point/edge
refs and boundary-aware profile refs, including existing refs loaded from
disk; it is not limited to refs added by the current command. If any would
become invalid, the entire command is refused. A side-count edit with no
S04-aware references in the coordinated schema is one ordinary atomic
parameter update and
creates the new descriptor; old v15 geometry-only profile references remain
on their existing resolver path. This keeps legacy documents compatible
without allowing a typed reference to enter a partially broken state.
Undo/redo of an accepted side-count edit is the same single parameter command;
undo/redo of a refused edit is empty.

## Compatibility, schema, and persistence

The current roadmap calls for no silent conversion of legacy entities. The
compatibility rules are therefore:

* A v15 document with a rectangle or polygon is opened exactly as the current
  composite node. It has no new point refs and no generated line children.
  v15 is never a legal carrier for a tagged topology ref, boundary token, or
  promotion ownership field; a v15 payload containing one is rejected as a
  malformed document rather than silently upgraded.
* At this baseline `PROJECT_DOCUMENT_SCHEMA_VERSION` is v15. S04's tagged
  point/edge refs, `sourceBoundaryLoops`, and promotion `origin` are future
  fields and may be written only by the one additive schema envelope selected
  from the actual merged S01/S04/R01 base. Loading v15 keeps the current
  composite node and does not synthesize any optional fields. Loading and
  saving the coordinated newer schema run the same recursive validator over
  every constraint operand, topology descriptor, boundary token, and
  promotion record. Unknown descriptors and `promotion-structure` records
  without a promotion owner are refusals.
* Existing primitive constraint records remain byte-for-byte compatible in
  meaning. New tagged refs are additive fields in that coordinated envelope
  and are validated on both load and save, not merely when a new UI command
  creates them.
* Existing region refs continue through their current resolver tiers. They are
  not rewritten to boundary tokens merely because the current client can
  derive them.
* The shared normalization is no-op/additive for legacy data: it does not
  synthesize refs, constraints, line children, or boundary provenance. Future
  schema versions must be rejected before stamping, matching
  `normalizeDocument`'s current fail-closed rule. If another approved slice
  increments the shared document schema before S04 lands, S04 uses the next
  monotonic version selected from that merged base; S01 annotation fields do
  not get a private competing schema counter.
* Saving, cloning, cloud sync, and save-state branching copy refs as document
  data. Derived profiles, virtual solver graphs, and display polylines remain
  rebuild products and are not persisted as an alternate source of truth.

The schema bump should land with fixtures proving that a legacy document has
the same nodes, object IDs, command log, and downstream profile references
after normalize/save/reopen. A migration must not synthesize constraints,
split nodes, or change profile selection.

## Undo, redo, and replay contract

Every S04 mutation is one command transaction, following the existing command
factories and document-core pattern:

* add/delete a composite constraint records the generated constraint ID and
  exact tagged refs;
* a supported parameter solve records the resulting canonical composite
  parameter values and preserves the constraint records;
* a stale or non-representable solve records no document mutation and leaves
  the previous derived exact result visible; and
* explicit conversion, when implemented, records the complete promotion map
  in one command so undo restores the original composite and redo restores the
  same line IDs and aliases.

After save/reopen, replay must resolve the same object IDs and topology tokens,
produce the same region selection, and either rebuild the same exact body or
return the same named refusal. A preview-only virtual graph is never an
identity oracle.

## Acceptance matrix

| Case | Observable acceptance | Evidence target |
| --- | --- | --- |
| Legacy rectangle opens | v15 document retains one rectangle node, old IDs, old command log, and identical region selection | document-core migration test plus persistence round trip |
| Legacy regular polygon opens | Same as rectangle; no synthesized line nodes or constraints | migration fixture |
| Rectangle vertex/edge refs | All four corners and edges resolve in canonical order; width/height/center edits preserve refs | shared validation and solver adapter tests |
| Polygon vertex/edge refs | `n` refs resolve top-first/CCW; radius/center edits preserve refs | geometry identity tests for 3, 6, and 64 sides |
| All constraint operand kinds | Point, curve, tangent, midpoint, distance, and angle operands use the tagged union or their existing primitive form; concentric/radius reject composites with named diagnostics; deleting a referenced object removes every affected constraint and undo restores IDs | document-core validation/deletion matrix plus GCS translation fixtures |
| Supported constraint solve | A compatible distance/coincident/midpoint/edge constraint solves against the derived structural equations, reports canonical DOF, commits one exact parameter edit when residuals pass, and replays | solver/apply-solve tests; one browser flow |
| Deterministic inverse solve | Rectangle and regular-polygon fits regenerate every canonical vertex within tolerance; under-constrained unchanged seeds may preserve constraint records, while changed, rotated, reflected, or inconsistent virtual graphs do not write geometry back | inverse-fit tests with repeated replay |
| Expression preservation | Unchanged expression fields remain byte-for-byte; changed expression-backed composite fields refuse with a named conflict; constraint expressions remain raw | expression-backed rectangle/polygon tests |
| Non-representable solve | Free corner deformation refuses with a conversion instruction; node, history, and exact derived result stay unchanged | command and browser refusal test |
| Polygon side-count change | With any existing typed constraint or boundary-aware downstream ref, every sides-changing path refuses with no mutation; without one, one accepted parameter command changes the descriptor; v15 geometry-only refs keep their legacy path | atomic preflight tests for direct edit, expression/update, and solver write-back plus legacy v15 replay test |
| Region after rectangle resize | New boundary-aware extrusion resolves the same source region; exact body rebuilds and face lineage remains source-derived | region-profile and exact lineage tests |
| Boundary provenance | Exact `b1/...` tokens validate; outer and hole loops compare sequence-aware multisets with repeated split-edge tokens preserved; a changed split count refuses before witness fallback | token parser, loop canonicalization, hole, split-edge, and crossing-count tests |
| Region ambiguity | An edge split into multiple candidate cells refuses unless sample/area selects exactly one; array order and nearest geometry never decide | resolver test |
| Upstream deletion | Dependent deletion follows load-bearing policy; no dangling reference survives save | document-core command test |
| Explicit conversion | Existing point/edge/center operands remap through edge endpoints/lines/center spoke while preserving user constraint IDs and expressions; only legal coincident/horizontal/vertical/parallel/equal/distance payloads with promotion ownership are generated; missing aliases refuse before mutation | promotion remap and structural-constraint tests, when that slice starts |
| Conversion undo/replay | Undo restores the exact composite and constraint array; redo reuses generated line/system IDs and alias map after save/reopen | command-log replay test, when that slice starts |
| Annotation interaction | S01 label placement is keyed by `constraintId`; moving a label never changes a composite point/edge or driving value | S01 annotation persistence tests |
| Future schema refusal | v15 legacy loads without synthesized fields, coordinated-schema tagged refs validate on load/save, and newer/unknown topology schema is refused without stamping or partial load | normalization, save, and round-trip tests |

The S04 row is complete only when the supported subset and refusal boundary are
covered. A passing geometry test alone does not prove saved-history replay or
downstream region identity.

## Review finding dispositions

This revision resolves the five design-review findings without adding runtime
code:

1. **Curve operands, deletion, and solver coverage:** `SketchCurveRef` is now
   the common operand for every line-like constraint kind, with an explicit
   table for tangent, concentric, midpoint, radius, distance, and angle. One
   recursive reference walker owns validation/deletion across strings, tagged
   edges, points, and arc contact points; the GCS handle map and residual IDs
   cover every row.
2. **Parameter mapping and expressions:** rectangle and regular-polygon
   inverse fits are canonical regeneration checks, not averages; under-
   constrained results retain the deterministic canonical seed when geometry
   is unchanged, while changed ambiguous or rotated/reflected/inconsistent
   results do not commit. Structural equations and rank/DOF diagnostics keep
   valid composite graphs from being treated as free independent lines. Raw
   expressions remain byte-for-byte unless a changed expression-backed field
   causes an explicit conflict refusal.
3. **Boundary provenance:** the `b1/...` grammar is fixed, and provenance is
   outer-loop plus a sequence-aware multiset of hole loops. Repeated split-edge
   tokens remain repeated, loop roles remain distinct, and sample/area is only
   a unique disambiguator among exact multiplicity matches. A changed split
   count is a topology refusal, never a normalization.
4. **Promotion remapping:** explicit conversion maps vertices, edges, and
   centers through generated endpoints/lines/center spokes, preserves user
   constraint IDs and raw values, adds only legal existing constraint kinds
   with an explicit promotion owner, and refuses atomically when any alias is
   incomplete. Undo/redo reuses the same IDs and alias map.
5. **Polygon side-count behavior:** every sides-changing entry point shares an
   atomic preflight over all existing typed references; any match refuses
   with no mutation. An unreferenced polygon in the coordinated schema may
   change side count in one
   parameter command. Legacy v15 geometry-only references keep their existing
   resolver behavior.

## Bounded implementation slices

1. **Contract and fixtures.** Add shared tagged ref types, topology validation,
   canonical ordering fixtures, and migration tests. No UI conversion and no
   implicit decomposition.
2. **Region provenance.** Carry optional boundary tokens through composite
   curve expansion, profile references, and `resolveRegionProfiles`; preserve
   every legacy resolver tier and add ambiguity tests.
3. **Virtual solver bridge.** Lower composite refs to a temporary graph backed
   by parameter-coupled structural equations, expose structural residuals and
   canonical DOF diagnostics, support only parameter-representable
   rectangle/regular-polygon constraints, map solutions back to canonical
   parameters, and fail closed otherwise.
4. **Picking, labels, and diagnostics.** Expose stable snap targets, typed
   edge/point names, and refusal/recovery copy. Keep annotation placement
   presentation-only and keyed by `constraintId`.
5. **Explicit conversion (separate follow-up).** Implement the atomic
   composite-to-line command, promotion alias map, downstream resolver support,
   and full undo/save/reopen coverage. Do not start this slice by changing the
   default rectangle or polygon creation path.

## Review decisions requested

The implementation PR should obtain explicit agreement on these bounded
choices before changing runtime types:

1. Use semantic rectangle corner roles encoded by canonical indices and a
   versioned topology descriptor, not coordinate hashes.
2. Treat regular-polygon side-count changes as topology changes that stale all
   old point/edge refs, even when an index remains numerically in range.
3. Add optional boundary tokens for new region refs while preserving legacy
   `sourceEntityIds` and resolver behavior.
4. Refuse free-form composite deformation until the user invokes an explicit
   promotion command.
5. Keep annotation placement outside geometry identity; S01 persists placement
   by `constraintId`.
6. Use `SketchCurveRef` for every line-like operand, retain primitive string
   operands for compatibility, and validate/delete through one recursive
   reference walker across all constraint kinds.
7. Match new region provenance as outer-loop plus a multiset of canonical hole
   loops, preserving repeated tokens for split edges; never flatten it to a
   set.
8. Preserve user constraint IDs and raw expressions through explicit promotion;
   map centers through a generated construction center spoke, and refuse the
   entire conversion if any alias is incomplete.
9. Refuse polygon side-count edits atomically whenever any existing typed
   constraint or boundary-aware downstream reference would become invalid;
   preserve the legacy resolver path for old documents without typed refs.
10. Treat the coordinated future schema as the legal carrier for tagged refs,
    boundary loops, and promotion ownership; validate them recursively on both
    load and save, and reject those fields in v15 rather than silently
    normalizing them.
11. Solve composites through parameter-coupled structural equations with
    explicit DOF/residual diagnostics. Under-constrained seeded values may
    remain unchanged and commit; changed ambiguous geometry refuses.
12. Run one polygon-side-count preflight from every sides-changing entry
    point, including expression/update and solver write-back, against all
    existing typed refs, not only refs added by the current command.
13. Generate promotion structure only from existing constraint kinds: polygon
    radial preservation uses persisted `distance` payloads from the center
    spoke, not an invented radial kind; the construction spoke is owned and
    replayed by the promotion record.
14. Treat any changed repeated-token count from a crossing as a topology
    refusal. Sample/area can select only among candidates with exact token
    multiplicity; S04 never normalizes split counts.

## Source-grounded evidence

The proposal is based on the current repository at the baseline commit, in
particular:

* [`packages/shared/src/index.ts`](../../packages/shared/src/index.ts):
  composite object fields, current point refs, constraint unions, and profile
  reference compatibility comments.
* [`packages/document-core/src/index.ts`](../../packages/document-core/src/index.ts):
  additive schema normalization, current constraint validation, object update,
  and delete behavior.
* [`packages/geometry/src/regions.ts`](../../packages/geometry/src/regions.ts):
  deterministic rectangle/polygon expansion and profile identity derivation.
* [`packages/kernel-adapter/src/region-profile.ts`](../../packages/kernel-adapter/src/region-profile.ts):
  fail-closed profile resolution and entity-set fallback rules.
* [`packages/kernel-adapter/src/gcs-sketch.ts`](../../packages/kernel-adapter/src/gcs-sketch.ts)
  and [`apps/web/src/lib/sketch/applySolve.ts`](../../apps/web/src/lib/sketch/applySolve.ts):
  dense per-solve kernel handles, residual attribution, and current primitive
  write-back/expression behavior that S04 must adapt explicitly.
* [`apps/web/src/lib/sketch/constraints.ts`](../../apps/web/src/lib/sketch/constraints.ts)
  and [`apps/web/src/lib/sketch/edits.ts`](../../apps/web/src/lib/sketch/edits.ts):
  current picks, solver-facing constraints, and the existing composite refusal.
* [`test/region-extrude-lineage.test.ts`](../../test/region-extrude-lineage.test.ts):
  exact face lineage and rectangle resize evidence.
* [`test/document-core.test.ts`](../../test/document-core.test.ts):
  additive schema and constraint deletion/validation evidence.
