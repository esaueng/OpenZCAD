# S04: Constraint-capable composite sketch identity

Status: design proposal for review. No runtime behavior is implemented by this
document.

Baseline: OpenZCAD `main` at `efa2662910199e6d23d63f337e35d3d591614d21`.

## Decision summary

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
```

The eventual shared constraint types should make `SketchPointRef` a backward
compatible union of its current primitive form and `CompositePointRef`.
Line-like constraint operands (horizontal, vertical, parallel,
perpendicular, equal, angle, and midpoint's line) should accept a tagged
`SketchCurveRef` union containing the current entity form and
`CompositeEdgeRef`. Existing fields and values remain valid on read and replay.

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
add an optional canonical boundary-token list for new composite-aware
profiles. A generated segment gets a token derived from its source object and
canonical edge, for example:

```text
<entity-id>/rectangle-v1/edge/2
<entity-id>/regular-polygon-v1/sides-6/edge/4
```

The exact wire spelling is an implementation decision, but it must be a
versioned, parseable token rather than a coordinate hash. `SketchProfile` and
new `SketchRegionProfileReference` values should carry the sorted tokens in an
optional field such as `sourceBoundaryIds`. Legacy references remain
unchanged and do not acquire synthetic tokens on load.

New resolution order:

1. A reference with boundary tokens resolves only to a current profile whose
   contributing boundary tokens match and whose topology descriptor is valid.
2. If that leaves exactly one region, changed dimensions are accepted and the
   profile's geometry-derived fingerprint/area are refreshed for the rebuild.
3. If several cells share the same authored edge tokens (for example, an
   overlapping region split one edge), the resolver may use the stored sample
   point and area only when exactly one candidate remains. Otherwise it refuses
   as ambiguous.
4. A reference without boundary tokens follows the existing `profileId`,
   source-entity, and legacy geometric fallback tiers exactly as before.

This preserves the existing rectangle-extrude behavior proved by
[`test/region-extrude-lineage.test.ts`](../../test/region-extrude-lineage.test.ts):
resizing a rectangle changes the face hash but keeps the source lineage name.
New boundary tokens make the source edge explicit; they do not claim that a
source edge split into multiple derived faces has one-to-one identity. A split
that cannot be uniquely resolved remains a refusal.

`{ all: true, sourceEntityIds }` remains reserved for entity-wide outline
providers such as text. Rectangles and polygons must never be converted to
`all: true`, because that would silently select every region produced by a
composite and could change an extrusion's material intent.

### Explicit conversion mapping

The later conversion command must persist a promotion record containing:

* the source composite entity ID and topology descriptor;
* the generated line entity IDs and endpoint mapping for every old vertex and
  edge token;
* the source object’s prior parameters and construction/contributing state;
  and
* a versioned alias map used by profile and attachment resolvers.

The source composite remains available as a non-contributing history witness
or is replaced only through that command's explicit, reviewable operation. The
region resolver may follow the alias map from an old composite boundary token
to its promoted line entities, but it must refuse if the map is missing,
ambiguous, or partially deleted. The conversion is a separate implementation
slice; S04's initial stable-ref work must not invent a partial conversion.

## Upstream edits and deletion rules

| Upstream change | Constraint refs | Region/downstream refs | Required result |
| --- | --- | --- | --- |
| Rectangle width, height, or center changes | Same tokens; virtual points move | Same boundary tokens; recompute fingerprints and exact geometry | Commit and replay normally |
| Polygon radius or center changes | Same tokens while `sides` is unchanged | Same boundary tokens; recompute geometry | Commit and replay normally |
| Polygon `sides` changes | All refs carrying the old vertex/edge count become stale | Boundary tokens with the old descriptor do not match | Commit only through the normal stale-reference path; dependent rebuild refuses with a named diagnostic |
| Composite object kind changes | Existing composite refs no longer validate | Old source tokens do not match the new kind | Refuse when referenced, or require an explicit conversion command; never reinterpret an index |
| Composite is deleted | References cannot resolve | Load-bearing downstream deletion policy applies | Delete is refused or presents the existing dependent-delete flow; no dangling ref is saved |
| Object is deleted and recreated with a new ID | Old refs do not match | Old profiles do not rebind by geometry | Broken reference until the user explicitly repairs it |
| A different entity splits an authored edge into multiple cells | Token may occur in several candidates | Sample/area may disambiguate only uniquely | Otherwise fail closed as ambiguous |

Parameter edits that preserve topology must never delete constraints. A kind or
topology change may leave a diagnostic-bearing stale constraint for repair, or
be refused before commit, but it must not silently drop the user's design
intent. Deleting the source object follows the existing document-core rule
that constraints attached to a deleted object go with that object; undo must
restore them under their original IDs.

## Compatibility, schema, and persistence

The current roadmap calls for no silent conversion of legacy entities. The
compatibility rules are therefore:

* A v15 document with a rectangle or polygon is opened exactly as the current
  composite node. It has no new point refs and no generated line children.
* Existing primitive constraint records remain byte-for-byte compatible in
  meaning. New tagged refs are additive and are validated only when present.
* Existing region refs continue through their current resolver tiers. They are
  not rewritten to boundary tokens merely because the current client can
  derive them.
* A future schema bump should be a no-op/additive v15→v16 normalization for
  optional topology-aware fields. It must reject malformed tagged refs and
  unknown descriptor versions, and it must refuse newer schemas before
  stamping them, matching `normalizeDocument`'s current fail-closed rule.
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
| Supported constraint solve | A compatible distance/coincident/midpoint/edge constraint commits one exact parameter edit and replays | solver/apply-solve tests; one browser flow |
| Non-representable solve | Free corner deformation refuses with a conversion instruction; node, history, and exact derived result stay unchanged | command and browser refusal test |
| Polygon side-count change | Old refs become stale; no nearest-index or coordinate rebind occurs | stale-reference test |
| Region after rectangle resize | New boundary-aware extrusion resolves the same source region; exact body rebuilds and face lineage remains source-derived | region-profile and exact lineage tests |
| Region ambiguity | An edge split into multiple candidate cells refuses unless sample/area selects exactly one | resolver test |
| Upstream deletion | Dependent deletion follows load-bearing policy; no dangling reference survives save | document-core command test |
| Explicit conversion | Conversion is visible, one undoable command, and the alias map survives save/reopen; this is a separate slice | promotion tests, when that slice starts |
| Annotation interaction | S01 label placement is keyed by `constraintId`; moving a label never changes a composite point/edge or driving value | S01 annotation persistence tests |
| Future schema refusal | Newer/unknown topology schema is refused without stamping or partial load | normalization test |

The S04 row is complete only when the supported subset and refusal boundary are
covered. A passing geometry test alone does not prove saved-history replay or
downstream region identity.

## Bounded implementation slices

1. **Contract and fixtures.** Add shared tagged ref types, topology validation,
   canonical ordering fixtures, and migration tests. No UI conversion and no
   implicit decomposition.
2. **Region provenance.** Carry optional boundary tokens through composite
   curve expansion, profile references, and `resolveRegionProfiles`; preserve
   every legacy resolver tier and add ambiguity tests.
3. **Virtual solver bridge.** Lower composite refs to a temporary graph,
   support only parameter-representable rectangle/regular-polygon constraints,
   map solutions back to canonical parameters, and fail closed otherwise.
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
* [`apps/web/src/lib/sketch/constraints.ts`](../../apps/web/src/lib/sketch/constraints.ts)
  and [`apps/web/src/lib/sketch/edits.ts`](../../apps/web/src/lib/sketch/edits.ts):
  current picks, solver-facing constraints, and the existing composite refusal.
* [`test/region-extrude-lineage.test.ts`](../../test/region-extrude-lineage.test.ts):
  exact face lineage and rectangle resize evidence.
* [`test/document-core.test.ts`](../../test/document-core.test.ts):
  additive schema and constraint deletion/validation evidence.
