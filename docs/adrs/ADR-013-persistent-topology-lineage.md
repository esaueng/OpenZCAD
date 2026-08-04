# ADR-013: Persistent topology lineage

## Status

Accepted (2026-07-31). The additive schema-v5 reference and the verified
primitive, sweep, and supported rigid-transform lineage subset are implemented
inside schema-v6 documents on both exact adapters. This remains an additive
design over [ADR-011](ADR-011-unified-topology-identity.md); unsupported
operations retain fail-closed hash/witness resolution rather than synthesized
lineage.

## Context

ADR-011 gives a topology reference a kernel-neutral geometric fingerprint and
fails closed on zero or multiple matches. It cannot preserve intent when a
legitimate upstream edit changes a face perimeter, an edge endpoint, or another
fingerprint input. Persistent references therefore need a stable lineage name
in addition to the existing hash.

Lineage must not turn kernel history into a new guessing mechanism. The
canonical document and feature history remain authoritative, kernel handles
remain transient, and every candidate returned by a kernel must be checked
against exact geometry before it may carry a stable name.

The spike tested the pinned kernels rather than relying only on their generated
declarations:

- BrepKit `2.129.0` at commit
  `190bc0223393c150a2ce10636958ba4db01d0060` exposes
  `fuseWithEvolution`, `cutWithEvolution`, `intersectWithEvolution`, and
  `filletWithEvolution`. All return JSON text through TypeScript `any`.
  Runtime payloads contain maps from source handles to result handles and an
  explicit `deleted` array, although the generated `EvolutionResult` omits
  `deleted` and declares incompatible flat arrays.
- BrepKit fillet evolution documents that modified-face provenance is matched
  geometrically by normal and centroid. On the representative box fillet, only
  two of six source faces retained their complete ADR-011 witness; the other
  four changed perimeter, centroid, or both. Complete witness equality cannot
  validate every claimed modification.
- BrepKit has no evolution entry point for chamfer or the direct-edit methods.
- `occt-wasm` 3.8.0 is more capable than the initial plan assumed. It has typed
  history methods for translate, rotate, mirror, scale, fuse, cut, intersect,
  fillet, chamfer, shell, offset, and thicken, with an explicit `deleted`
  channel. Its `modified` array is a compact sequence of
  `[sourceHash, resultCount, ...resultHashes]` records.
- OCCT fillet and chamfer history returned an empty `generated` array for a
  one-edge box operation even though the result contained one new blend face.
  The new face can be found as a set difference, but its source relation is not
  represented.
- Both kernels' boolean history results precede the same-domain unification
  used by OpenZCAD today. For two overlapping boxes, each history result had 14
  faces while the production-style unified union had 6. Replacing the current
  call with the history variant would silently change production topology.

The executable characterization is in
`test/topology-lineage-spike.test.ts`. It covers a primitive, extrusion sweep,
rigid transform, boolean, fillet, and chamfer in both pinned kernels.

## Decision

### Kernel history is candidate evidence, never resolution

A kernel evolution relation may be consumed as **lineage input** only. It is
not a topology resolver and is never persisted directly. Each transition must
pass all of these checks:

1. The source key belongs to the complete set of source sub-shapes supplied to
   that exact operation.
2. Every claimed result belongs to the operation's actual final result,
   including all production post-processing such as same-domain unification.
3. The source-to-result relation is compatible under an exact, quantized
   carrier witness:
   - an unchanged sub-shape has an equal complete ADR-011 witness;
   - a rigid transform has exactly the witness obtained by applying the known
     document transform to the source witness;
   - a modified planar face remains on the same quantized plane;
   - a modified cylindrical face remains on the same quantized cylinder;
   - other modified surface and curve classes have no shared carrier witness
     in the current adapters and are rejected.
4. The compatible relation is unique. Two sources or results with the same
   carrier make the transition ambiguous unless the kernel supplies actual
   construction history that distinguishes them.
5. The result's complete exact witness is measured independently and recorded
   with the new lineage entry. Tessellation, proximity, traversal position,
   normal-angle thresholds, and centroid distance are not witnesses.

All comparisons use the frozen ADR-011 integer quantization. Raw floating-point
values are never compared with `==`.

This answers the geometric-matching question conditionally: BrepKit's
normal-plus-centroid fillet mapping can be accepted only as a proposal that
passes the checks above. It provides a safe fail-closed subset for unique
analytic carriers. It cannot provide complete fillet lineage, because modified
faces commonly fail complete-witness equality and coplanar or coaxial twins
cannot be distinguished by the carrier. Complete fillet coverage requires a
bridge implementation based on the fillet builder's construction history,
not nearest geometry.

### Operation coverage and bridge requirements

| Operation             | Safe lineage source now                                                                                                                                     | Bridge decision                                                                                                                                                                                                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Primitive             | Semantic names from the feature contract: oriented box faces, cylinder caps/wall, and equivalent proven roles                                               | No bridge needed                                                                                                                                                                                                      |
| Extrude/revolve sweep | Start/end caps and side faces derived from stable profile-region and sketch-object identities                                                               | No bridge needed; ambiguous profile boundaries fail                                                                                                                                                                   |
| Rigid transform       | One-to-one inheritance verified by applying the document's known transform to each exact witness                                                            | No bridge needed                                                                                                                                                                                                      |
| Pattern               | The seed keeps its lineage; copy names derive from the pattern feature, semantic instance index, and seed lineage                                           | No bridge needed; instance index is command data, not traversal order                                                                                                                                                 |
| Boolean               | Existing BrepKit/OCCT history is useful before post-processing                                                                                              | Full lineage requires history through the exact production unification path. Analytic results may be derived only when exact carrier grouping is unique; otherwise publish no lineage and retain unique-hash fallback |
| Fillet                | BrepKit supplies modified/generated proposals; OCCT supplies modified proposals                                                                             | Unique analytic carriers may propagate after verification. BrepKit needs construction-history provenance for full coverage. OCCT needs a correct generated-face relation for multi-edge/general blends                |
| Chamfer               | OCCT supplies modified proposals but omits the representative generated face                                                                                | BrepKit needs `chamferWithEvolution`. OCCT needs generated-face provenance for full coverage. Until then, BrepKit chamfer is explicitly `no lineage - hash fallback only`                                             |
| Direct edit           | Operation-specific analytic validation already proves the selected input, but neither current adapter exposes the complete output relation used by OpenZCAD | BrepKit needs evolution variants for planar push/pull and cylindrical resize. OCCT needs a feature-level history path for the composed edit. Until then, direct edits are `no lineage - hash fallback only`           |

Pattern copies are derivable because their transform and semantic instance
number are document data. They must not be matched by position after the fact.
Similarly, primitives and sweeps are regenerated from semantic construction
inputs, not matched against an older B-rep.

The minimum BrepKit bridge work for full Wave 2 coverage is therefore:

1. a versioned, typed evolution payload whose `modified`, `generated`, and
   `deleted` fields match runtime semantics;
2. boolean evolution through the same fuse/unify path used in production, or
   a separate `unifyFacesWithEvolution` step;
3. `chamferWithEvolution`;
4. evolution variants for planar push/pull and cylindrical resize; and
5. fillet provenance from construction history for cases the exact-carrier
   check cannot prove.

These are additive bridge APIs. OpenZCAD must not switch to a differently
post-processed history operation merely to obtain lineage.

### Deletion is explicit and validated

Absence from `modified` never means deleted. OCCT legitimately omits unchanged
faces from `modified`, and an undocumented bridge omission is not evidence of
destruction.

For BrepKit, OpenZCAD may use a local strict decoder for the pinned runtime
payload while the declaration is corrected. The decoder must require all three
channels and validate a complete partition:

- every source face occurs exactly once as a `modified` key or in `deleted`;
- the sets are disjoint;
- every modified/generated output is in the operation result; and
- modified plus generated outputs cover the pre-post-processing result.

A missing or malformed `deleted` channel invalidates the entire transition. It
does not become an empty array. When later post-processing changes topology, it
is a second transition and must have its own validated relation.

For OCCT, the typed `deleted` list is authoritative only after checking that
every value is an input hash and is disjoint from decoded `modified` sources.
Unchanged inputs are recognized by a unique exact witness in the result. Any
input that is neither explicitly deleted, verified modified, nor uniquely
unchanged makes the transition unavailable.

A validated deletion writes a lineage tombstone naming the deleting feature.
Resolution of a reference to that lineage reports the deletion; it never looks
for a nearby replacement.

### Additive schema-v5 topology reference

Schema v5 keeps every schema-v4 field readable and adds a tagged reference.
The public contract is conceptually:

```ts
type TopologyReferenceV5 =
  | {
      kind: 'edge';
      producingFeatureId: FeatureId;
      lineageName: string;
      currentHash: number;
      witnessVersion: 1;
      witness: EdgeWitnessV1;
    }
  | {
      kind: 'face';
      producingFeatureId: FeatureId;
      lineageName: string;
      currentHash: number;
      witnessVersion: 1;
      witness: FaceWitnessV1;
    };
```

`lineageName` is scoped by `producingFeatureId`. It is assigned from semantic
feature data or a validated evolution transition, never from a kernel handle,
traversal ordinal, or viewport ID. `currentHash` is the ADR-011 hash at the time
the reference is written. Recomputing the hash from the stored witness must
produce `currentHash`; a mismatch is a malformed reference.

Vertices are not first-class persistent selections today and are deliberately
outside this contract.

#### Exact edge witness

`EdgeWitnessV1` stores the exact inputs to `edgeSignatureOf` as quantized
integers:

- shared curve class and quantized exact length;
- for an open edge, the two quantized endpoint positions in lexicographic
  order and the quantized mid-parameter point;
- for a closed edge, the quantized mean of four equally spaced parameter
  samples and the canonical quantized curve-plane axis, or an explicit null
  axis when degenerate.

Closed B-spline edges remain unsupported cross-kernel as specified by ADR-011.
A v5 lineage resolver rejects them rather than using a weak witness.

#### Exact face witness

`FaceWitnessV1` stores the exact inputs to `faceSignatureOf` as quantized
integers:

- shared surface class;
- sum of unique exact boundary-edge lengths;
- mean of unique boundary-vertex positions, or explicit null when there are no
  vertices; and
- the analytic term: canonical plane normal plus signed offset, canonical
  cylinder axis plus axis foot and radius, or explicit `none` for other
  classes.

It additionally stores free-form surface closure as
`{ u: 'open' | 'closed' | 'unknown', v: 'open' | 'closed' | 'unknown' }`.
Closure is a guard and is not silently inferred from tessellation.

Coordinate and length integers use the frozen `1e-6` document-unit quantum;
direction integers use the frozen 1000-times-finer quantum. Changing either
requires a new witness version and dual registration.

### Explicit closed B-spline/NURBS guard

For surface class `bspline` or `nurbs`, reference creation and lineage
resolution are rejected when either parametric direction is closed/periodic or
when closure is unknown. Unknown is unsafe, not open.

The pinned BrepKit bridge exposes free-form NURBS periodicity. The pinned OCCT
bridge exposes only the surface class and UV bounds, not free-form periodicity.
Consequently all OCCT B-spline/NURBS faces are conservatively unsupported for
v5 persistent references until the OCCT bridge exposes periodic-U and
periodic-V flags. This is intentionally stricter than rejecting only proven
closed surfaces; it is the only cross-kernel way to make the closed-surface
rule explicit today.

Analytic periodic surfaces such as cylinders and tori are not covered by this
guard. They use their analytic surface class and the witness rules above.

### Resolution order

Resolution is:

1. Rebuild and validate the lineage transition chain. Resolve only a unique
   compatible entry with matching topology kind and a supported exact witness.
2. If lineage is absent (legacy schema or an operation explicitly marked no
   lineage), use `currentHash` plus the stored exact witness only when exactly
   one current sub-shape matches both.
3. Otherwise fail visibly without document mutation.

The stored witness is the selection-time witness used for integrity, fallback,
and diagnostics. A valid lineage may intentionally evolve to a different
current witness after an upstream parameter edit; each intervening transition,
not stale-witness equality, proves that continuity.

## Gate decision and implementation state

**The additive schema and safe subset passed the gate and are implemented.**
Semantic primitive/sweep lineage and supported rigid-transform inheritance are
published only with independently measured exact witnesses. Face-attached
sketches consume this subset at their history position as specified by
[ADR-014](ADR-014-true-face-attachment.md).

Boolean and blend propagation may ship only for transitions that pass the
exact checks above. Current boolean post-processing, blends, patterns,
direct-edit output, and imported STEP provenance remain explicitly `no lineage

- hash fallback only` where complete evolution is not available. Unsupported
  or ambiguous transitions stay visible diagnostics.

## Amendment (K0.6, 2026-08-01): imported STEP topology is named

The clause above listed "imported STEP provenance" alongside blends and direct
edits as `no lineage - hash fallback only`. That grouping conflated two
different things, and the parity corpus made the difference measurable.

A blend or a direct edit is a **transition**: it consumes an earlier body and
the kernel owes an output relation OpenZCAD cannot currently verify, so it fails
closed. An import is not a transition at all — it is the **root** of its own
lineage. There is no earlier body whose names could be carried across, so there
is nothing to fail closed about. The original clause therefore governs
provenance *through* an import, which remains unavailable, not identity *within*
one, which is exactly what a stored face pick on a supplier file needs.

So an `imported-step` body publishes schema-v5 references with capability
`derived`:

- the **name** is `import.step.{face,edge}.<hash>`, the topology's own frozen
  ADR-011 fingerprint in hex. An import has no feature contract to name its
  topology from — the file is the whole semantic input — and the only
  kernel-neutral identity inside it is the exact witness. This is neither a
  kernel handle nor a traversal ordinal nor a viewport id, which are the three
  things this ADR prohibits; it is a deterministic function of exact geometry;
- the **witness** is measured independently at import and stored with the
  reference, so recomputing the hash from it reproduces `currentHash`;
- publication is one-to-one or nothing. Two faces sharing a witness — the two
  hemispherical patches of a BrepKit sphere are the corpus case — publish no
  reference at all rather than an ambiguous one;
- the closed B-spline/NURBS guard is unchanged and still fail-closed. Nothing
  was loosened to make an import publish more.

Both exact adapters implement the same rule rather than a kernel-specific one.
That is deliberate and time-limited: while OpenCascade still exists, the parity
corpus can assert that both kernels give an imported body the *same* lineage
names, which is the evidence the Z3 STEP route flip needs that a pick stored
today survives the flip. Before K0.6 neither adapter published any reference on
an imported body, so the question could not be asked.

Full boolean, fillet, chamfer, and direct-edit lineage is blocked on the bridge
requirements listed above. In particular, neither kernel's current raw boolean
history may replace the production unified operation, and BrepKit chamfer or
direct edit must not synthesize lineage by geometric proximity.

## Amendment (Z7, 2026-08-01): a partial revolve is hash-only on purpose

The coverage table above says "Extrude/revolve sweep — no bridge needed". That
stays true for a full turn and is **not** true below one. Exposing the revolve
angle therefore makes a scope decision explicit rather than leaving it to be
discovered later: a revolve of less than 360 degrees publishes ADR-011
hash-only references, and the reason is named in code as
`PARTIAL_REVOLVE_HASH_ONLY_REASON` (`packages/kernel-adapter/src/exact.ts`).

Measured, not assumed. The solid itself is fine at every angle — one closed
shell, `validateSolid` 0, watertight tessellation, and a volume that matches
Pappus times `angle/360` to 1e-9. Two separate things break in the *lineage*:

- `expectedCircleWitness` hard-codes `closed: true` and `length: 2*pi*r`. Below
  a full turn the corresponding edges are **arcs**, an `EdgeWitnessV1` variant
  that witness can never equal, so every profile-vertex edge role fails at
  every angle under 360.
- BrepKit splits a swept face at each 90 degree boundary — measured at 6 faces
  at <=90, 10 at 91-180, 14 at 181-270, 18 at 271-359.9, and 4 at 360 — and
  the pieces carry duplicate analytic parameters, so
  `addUniqueSemanticAssignment`'s exactly-one-match rule goes ambiguous above
  90 degrees as well.

Two things this amendment does **not** loosen:

- **A full turn is unchanged.** All four swept faces and all four
  profile-vertex circle edges keep their `sweep.*` names, and the body carries
  no lineage diagnostic. This is asserted directly, not inferred.
- **A circular profile is exempt at every angle.** Its role is the single torus
  surface, named by surface type rather than by an analytic carrier, and a
  torus does not quadrant-split: a partial revolve of a circle measures three
  faces (torus plus two caps) and the torus role stays unique. That branch
  publishes no profile-vertex edge roles either, so neither break applies.

Reversing this needs an arc-capable edge witness and a piece-aware face role.
It must not be reversed by matching a wedge's faces geometrically.

## Consequences

- Schema-v5 references are additive inside current schema-v6 documents, and
  legacy documents continue to replay through normalization and the ADR-011
  fallback.
- A stable lineage name can survive legitimate geometry changes without making
  a stale selection authoritative.
- Kernel history bugs, hash collisions, ambiguous splits/merges, malformed
  deletion payloads, and unsupported free-form surfaces fail closed.
- Some operations retain hash-only behavior. This is a visible
  capability limit, not a silent approximate implementation. Partial revolve
  is the first case where that limit was accepted *before* shipping the
  feature rather than found afterwards; see the Z7 amendment.
- The original spike remains characterization evidence. Production now uses
  only the separately reviewed safe subset; remaining bridge work does not
  block that subset and must not be bypassed with proximity matching.
