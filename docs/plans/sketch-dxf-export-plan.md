# Whole-sketch DXF export plan (D04)

Status: design slice for review. This document defines the first useful
whole-sketch export contract; it does not add the export command, DXF import,
drawing sheets, or a document-schema version.

## Problem and boundary

OpenZCAD currently writes DXF R12 for one selected planar B-rep face and for
an exact section. The writer is deliberately small and unit-aware, but the
worker has no operation for a saved `SketchNode`. D04 needs a sketch export
that can be taken to a laser cutter or 2D CAD program without silently
turning authored geometry into a mesh or omitting an entity the user drew.

The first slice is one complete saved sketch, evaluated at the document's
current parameter scope. It exports the sketch's own 2D geometry in the
sketch plane. It does not flatten bodies, create sheet views, include hidden
lines, or import DXF. A later flattened-view export may consume the same
pure 2D entity extraction, but it must define its own world/view projection
and must not change this contract.

The implementation should add a kernel-adapter operation equivalent to:

```ts
exportSketchDxf(document: ProjectDocument, sketchId: SketchId): Promise<string>
```

The worker and UI may add a corresponding request later. The adapter owns
history and face-attached-plane resolution; `@openzcad/io-dxf` remains a
format writer and does not inspect document nodes.

## Exact output subset

All objects are preflighted before `writeDxf` is called. The exporter either
writes the complete supported sketch or refuses with a named reason; it never
writes a partial file after silently dropping an authored object.

| Sketch object | DXF output | Exact construction rule |
| --- | --- | --- |
| `line` | one `LINE` | Resolve `x1,y1,x2,y2` and preserve both endpoints. A zero-length line is refused. |
| `circle` | one `CIRCLE` | Resolve center and positive radius. No sampled points. |
| `arc` | one `ARC` | Resolve center, radius, and degree endpoints. DXF's counter-clockwise start/end convention preserves the sketch's counter-clockwise sweep, including sweeps crossing 0°. A true zero sweep is refused. |
| `arc` with a raw `endAngleDeg - startAngleDeg` of `+360°` | one `CIRCLE` | DXF R12 has no portable full-turn arc representation; a full-turn sketch arc is the same exact locus as a circle. The conversion is recorded in the export diagnostic, if diagnostics are exposed. |
| `rectangle` | four `LINE`s | Use the same exact corner order and centered dimensions as `rectangleProfile`; do not use a sampled polyline. |
| `polygon` | N `LINE`s, N in [3, 64] | Use the same exact regular-polygon points and top-start counter-clockwise order as `polygonProfile`; do not approximate a circle or emit a mesh. |
| `text` | refusal | Glyph outlines are derived font curves, not persisted sketch primitives. Until an exact text-to-DXF outline contract exists, omitting or flattening text would misrepresent the sketch. |

Rectangles and regular polygons are composite parameterized objects, but their
edges are exact straight segments already defined by the shared geometry
helpers. They are therefore safe to lower to individual lines. The exporter
must not treat arbitrary detected regions, text glyph samples, Bezier samples,
or `sampleEdge` output as analytic sketch entities.

Constraints, dimensions, and solver diagnostics are design intent and do not
become DXF geometry. The exporter uses the persisted object values at the
current parameter scope; it does not run a new solve or mutate the document.
If a parameter expression cannot be resolved, the whole export refuses as an
unresolved-parameter error.

## Construction geometry and completeness

`construction: true` is reference-only geometry in the shared sketch model.
The default and only first-slice policy is to exclude it from manufacturing
DXF output. It is not put on layer 0, and it is not converted to a different
line type because the current writer has no layer contract for construction
geometry. A diagnostic may report how many construction objects were
excluded, but the bytes contain none of them.

If every object is construction geometry, the export refuses with
`construction-only` rather than producing an empty file. If a non-construction
text or another unsupported object is present, the export refuses the entire
sketch rather than exporting the remaining lines and hiding the omission.
This makes the completeness rule observable and safe for fabrication.

The object order is the sketch node's `objectIds` order. Composite edges use
the helper's stable order. This is deterministic for unchanged history and
keeps the output easy to compare, while DXF readers remain free to reorder
entities on import.

## Plane and coordinate contract

DXF is a planar file, so the output coordinates are sketch-local `(u,v)`
coordinates, not world `(x,y,z)` coordinates:

```text
worldPoint = basis.origin + basis.u * u + basis.v * v
DXF point  = (u * UNIT_TO_MM[document.units],
              v * UNIT_TO_MM[document.units], 0)
```

The basis is the same right-handed basis used to rebuild the sketch:

- canonical `XY`, `XZ`, and `YZ` references use `frameForPlaneRef`, including
  the resolved canonical offset;
- arbitrary frame references use their persisted frame after validating finite,
  non-degenerate, orthonormal axes and `u × v = normal`;
- face-attached sketches use the exact history-position face lineage through
  `resolveSketchBasisAtHistory`. A missing, deleted, ambiguous, or non-planar
  face attachment refuses; the embedded migration frame is not a new fallback
  for a schema-v5 face reference.

The extractor does not project world points or derive a view from the current
camera. In particular, an `XZ` sketch keeps the shared basis's signed local
`v` direction, so its authored arc orientation and polygon winding are
preserved. A separate flattened-view feature may choose a presentation frame,
but that is outside D04's sketch-local export.

The basis is validated before any entity is emitted. A corrupt frame, a
non-finite parameter, or a value outside the writer's representable range is
a refusal. No broad tolerance is introduced to make a malformed frame pass.

## Units and numeric safety

Sketch values are stored in document units. Every linear coordinate and
radius is multiplied exactly once by `UNIT_TO_MM` (`mm=1`, `cm=10`,
`m=1000`, `inch=25.4`). Angles stay in degrees. `writeDxf` emits
`$ACADVER=AC1009`, `$INSUNITS=4`, and `$MEASUREMENT=1`, so readers know that
the emitted coordinates are millimetres.

The existing writer's `formatDxfNumber` is the final serialization guard:
it rejects non-finite values and magnitudes at which JavaScript fixed-point
formatting would become exponent notation, trims trailing zeros, and
normalizes signed zero. The sketch extractor must validate positive radii,
polygon side bounds, nonzero line lengths, and nonzero arc sweeps before it
reaches the writer. A writer error remains a refusal, never a fallback to
rounded or tessellated geometry.

## Orientation and entity semantics

The sketch object model defines arcs as counter-clockwise from `startAngleDeg`
to `endAngleDeg`, with wrapped values such as 300° to 60° meaning a positive
120° sweep. DXF R12 `ARC` uses the same counter-clockwise interpretation, so
the two stored degree values are passed through after finite/range checks.
The exporter classifies the raw difference before modulo normalization:
`end-start === 0` is a zero-sweep refusal, while an allowed raw `+360°`
means full-circle intent and follows the exact `CIRCLE` rule above. A
normalization that turns either case into equal ARC endpoints must never be
serialized as a zero-length `ARC`; it must become the exact circle or refuse.
Angles may be normalized for stable text only if that leaves the directed
sweep unchanged. A negative raw difference that crosses zero must never be
swapped as though it were a clockwise arc.

Rectangle and polygon expansion follows the exact shared helpers, including
the polygon's top-start convention. Each segment is a `LINE` rather than a
`POLYLINE`, which avoids introducing implicit closure or relying on the face
exporter's sampled-curve path. Circle and arc objects remain analytic DXF
entities. No entity receives a fabricated Z coordinate other than the DXF
plane's required zero.

## Refusals

The implementation should expose stable machine-readable reasons alongside a
human message where the worker boundary can carry them. The minimum set is:

| Reason | Trigger |
| --- | --- |
| `sketch-not-found` | The requested sketch ID is absent. |
| `parameters-invalid` | Parameter scope has evaluation errors. |
| `stale-plane-attachment` | Face lineage cannot resolve exactly at sketch history position. |
| `invalid-plane-frame` | Basis axes are non-finite, degenerate, non-orthonormal, or not right-handed. |
| `unsupported-object` | A non-construction object is text or a future/unknown kind. |
| `invalid-geometry` | Non-finite values, non-positive radius/dimension, zero-length line, invalid polygon sides, or zero/invalid arc sweep. |
| `construction-only` | No manufacturing entities remain after intentional construction exclusion. |
| `writer-refused` | The format writer rejects a value or cannot assemble the R12 document. |

The exporter should include the source object ID in object-specific refusal
messages, but it must not invent a stable DXF entity identity. R12 has no
standard object-ID field that this writer currently promises to preserve.

## Independence from D01 and future S04 identity

This operation is independent of D01 sheet/view nodes. It does not create or
read sheets, view scales, title blocks, annotations, hidden-line state, or
paper-space coordinates. D01 can later consume the exact local-entity
extractor for a view, but the sheet layer must own its projection and
presentation transform.

It is also independent of S04's future typed entity identity and boundary
carrier work. The first exporter uses the existing `SketchNode.objectIds`
order and object payloads. If S04 adds typed refs or boundary/origin carriers,
the adapter may use them to resolve a richer sketch in a later version, but
must preserve this slice's local-coordinate and fail-closed rules. No schema
version bump or identity-field write is part of D04.

## Implementation shape and acceptance

The pure extractor should live beside the exact adapter's sketch/profile
resolution, taking resolved sketch objects, a validated `PlaneBasis`, and the
document unit scale. It should return `DxfEntity[]` or a typed refusal. The
adapter method should:

1. find the sketch and evaluate the document parameter scope;
2. build/replay history so face-attached basis resolution is exact and the
   basis is available at that sketch's history position;
3. resolve every object in object order, applying construction and supported
   kind policy;
4. preflight the complete list, including the non-empty manufacturing check;
5. call the existing `writeDxf` exactly once.

Required tests for the implementation PR:

- a canonical XY rectangle exports four exact lines with its millimetre
  dimensions;
- canonical XZ and YZ sketches preserve local coordinates and orientation;
- inch and centimetre documents scale coordinates and radii once, and the
  header declares millimetres;
- a circle remains `CIRCLE`, arcs crossing 0° remain the same directed
  `ARC`, raw `start=0°, end=360°` becomes `CIRCLE`, and raw `start=0°,
  end=0°` refuses without emitting a zero-length `ARC`;
- a polygon exports the exact bounded side count and no sampled polyline;
- an expression-driven value is resolved, while an unresolved expression
  refuses the whole file;
- construction geometry is omitted, construction-only sketches refuse, and a
  sketch containing non-construction text refuses rather than dropping text;
- stale/non-planar face attachments refuse, and a corrupt frame refuses;
- non-finite, zero/negative, oversize, degenerate, and invalid-side inputs
  refuse before partial output;
- output is deterministic for the same document and object order.

The existing writer qualification remains a prerequisite rather than a new
claim: `test/dxf-writer.test.ts` covers the R12 skeleton, millimetre header,
analytic group codes, R12 polyline framing, finite-number refusal, and the
no-exponent guard. `test/dxf-face-export.test.ts` and
`test/exact-section.test.ts` cover the existing exact face/section adapters;
their sampled fallback behavior must not be reused for the sketch subset.

Roadmap evidence for this design belongs on D04. Runtime implementation,
worker/UI wiring, DXF import, and sheet flattening remain separate follow-up
work.
