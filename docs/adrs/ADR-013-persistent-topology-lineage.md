# ADR-013: Persistent topology lineage

## Status

Accepted (2026-07-31). The additive schema-v5 reference and the verified
primitive, sweep, and supported rigid-transform lineage subset are implemented
inside schema-v6 documents on both exact adapters. This remains an additive
design over [ADR-011](ADR-011-unified-topology-identity.md); unsupported
operations retain fail-closed hash/witness resolution rather than synthesized
lineage.

Remus superseded the production BrepKit dependency in ADR-020. The BrepKit
names and measurements below remain the historical evidence for the lineage
contract; the Remus adapter inherits and must preserve that behavior.

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
  `4ddc2c7b22b1303fca3e1cfe4834b735242994f9` exposes
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
exact checks above. The boolean analytic subset shipped on 2026-09-02: a
result face inherits an operand face's identity when it is the only named
operand face and the only result face on one quantized plane or cylinder,
re-verified against the operand's own exact witness; for an add/cut extrude
the tool cap coincident with the target plane yields to the target face by
construction. Shared and split carriers publish diagnostics, not names. Current boolean post-processing, blends, patterns,
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
provenance _through_ an import, which remains unavailable, not identity _within_
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
corpus can assert that both kernels give an imported body the _same_ lineage
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
Pappus times `angle/360` to 1e-9. Two separate things break in the _lineage_:

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

## Amendment (M07, 2026-11-12): inferred journal bindings are not history

A journaled operation's `resolveOperationOutput` record carries a
`provenance`. `construction` is the kernel's record of what a source entity
became; `inferred` is a pairing it made afterwards. The kernel's boss
cylinder resize rebuilds the solid in a different face order and infers its
bindings positionally, and the move-face reader took them as construction
history: a side plane's name was published on the top face, the top's on the
bottom, and one name on two faces. The move-face reader now accepts only
`construction` bindings. A source the journal only inferred keeps the
unchanged-witness carry, and otherwise stays hash-only.

That leaves a body whose lineage is **partial**: it names some faces and
deliberately leaves others unnamed. Step 2 of the resolution order applies to
exactly those entities ("an operation explicitly marked no lineage"), so
direct-edit, edge-modifier and face-set resolution pass the `partial`
availability while some candidate of the kind is unnamed:

- a name the body still publishes resolves by lineage alone, and its
  ambiguity or unverified evidence stays terminal;
- a name the body no longer publishes anywhere may resolve by the stored hash
  plus the exact stored witness, unique, and **only onto an entity the body
  publishes no name for**. It can never move a reference onto a named entity.

This is what keeps documents saved while inferred bindings were consumed
replaying: their later features stored the misplaced names together with the
exact witness of the face they actually picked. The default availability is
unchanged; a matching hash is still never a silent v5 rebind there.

## Amendment (M07, 2026-11-12): journal outputs are not source-indexed

The amendment above attributed the wrong names to positional inference. The
kernel's boss-resize bindings are geometrically correct; the reader misread
them. `resolveOperationOutput(op, kind, i)` is the op's `i`-th output in
journal event order, which is result order, and it reports no source. The
move-face reader read output `i` as what source face `i` became. That is right
only while the kernel rebuilds faces in source order, and construction moves
do not always: on a body with rounded corners a face-distance edit swapped the
corner bands' names across the part.

Move-face journals are now read by the kernel's own events. Each source face
gets a unique scratch face name, `propagateAttributesForOp` carries the names
along the journaled `Preserved`/`Modified` events, and the result faces' names
are read back and restored. A split source, and every unbound source of a
journal that merged sources, publishes no name and takes no fallback.
Pattern face claims keep their checked layout reading: the kernel journals
copies as `Generated`, which propagation does not follow, and a claim there can
only withhold a name the transformed witness already proves.

Correctly paired `inferred` history is still refused. Trusting it would
publish each name on the face that really owns it, and a document saved while
the old reader named faces stores some of those names for a different face.
Lineage resolution treats a published name as authoritative, so such a
reference would resolve to the name's real owner: replaying the legacy case in
`test/cylinder-resize-face-lineage.test.ts` with inferred history trusted
resolves the wall resize onto a plane ("The selected face is no longer
cylindrical"), and a plane-to-plane push would move the wrong face without an
error. Refused, those names are not published, and step 2 above finds the
picked face by its exact stored witness.

Fixing the construction reader has the same edge for documents that stored a
name the old reader misplaced after a construction move: their reference now
resolves to the face that owns the name. The reader cannot tell those documents
apart, and keeping the defect would misname every new edit of that kind.

## Amendment (H01/M07, 2026-11-12): predicted-carrier carry for unjournaled direct edits

The coverage table lists direct edits as `no lineage - hash fallback only`
wherever the kernel exposes no output relation, and the M07 amendments keep
that for a boss resize the kernel journals only by inference. Losing every
name on such an edit is not fail-closed in practice: each later reference to
the body falls back to its selection-time witness, which any upstream edit
invalidates. On a reported box ∪ cylinder history one boss resize dropped the
body from 8 named faces to 2, and changing an upstream seam fillet's radius
then failed 20 later features as "lineage no longer exists".

A direct edit, unlike a fillet, is defined by its command: the command
determines the carrier each analytic face ends on. A direct edit with no
verified construction relation — the exact sleeve and blend-ladder wall
resizes, the analytic cap offset, a face move the kernel could not journal,
a blend resize the kernel journaled only by inference, a blend or face-feature
removal, an imported hole resize, and a move or wall resize the kernel
journaled only by inference — now carries names by **exact predicted
carrier** (`deriveRemusPredictedCarrierDirectEditLineage`):

- a face the command does not touch is predicted on its own quantized plane
  or cylinder; the edited face on the carrier the command constructs (a planar
  offset: the same normal, the offset shifted by the commanded distance along
  the recorded outward normal; a wall resize: the same axis and foot, the
  commanded radius; an imported blind-hole resize: the recorded axis, the
  commanded radius); a face whose surface the command does not determine (a
  resized or re-blended band) is predicted on nothing;
- a named source face's identity crosses only when its reference re-verifies
  against the source solid's measured witness, no other source face, named or
  not, predicts the same carrier, and exactly one result face lies on it.
  Coplanar or coaxial twins, splits and merges therefore publish nothing,
  which is check 4 above with the command, not kernel history, supplying the
  claim;
- the result face's complete witness is measured independently and recorded;
  names on non-analytic surfaces cross only by an unchanged exact witness, as
  do edges, and boundary edges between carried faces are then named as for
  the other operation-level builders;
- a result face the carrier and the unchanged witness name differently, or an
  identity landing on two faces, publishes neither.

All comparisons are the frozen ADR-011 integers. Nothing is matched by
proximity, normal angle, centroid distance or traversal order.

The rule does not override history. A construction relation, where the
kernel supplies one, is read exactly as before. For a body whose producer is a
primitive, the primitive's semantic re-derivation still outranks a carried
name after an edit that ran no journal, as it did before.

**Inferred journals keep the M07 protection.** From 2026-11-03 to 2026-11-12
the move-face reader published each name where the kernel's positional,
inferred binding put it, and documents saved then store some names together
with another face's witness. A carried name is therefore withheld wherever
that retired positional reading of the same journal put the name on a
different face, or put another name on its face
(`retiredPositionalFaceMap`). The retired reading is never a source of names;
it can only withhold one, and an unchanged exact witness is not affected by
it. Those withheld names stay hash-only — the documented M07 trade-off — so a
saved reference to one still resolves only by its exact stored witness, and a
later upstream edit that changes that witness still fails visibly. Remus
emitting construction provenance for boss resizes remains the complete fix.

Limits: free-form bands get no name from this rule; a carrier the edit leaves
shared between faces publishes no name; and a name the retired reader
misplaced cannot be carried. The predicted carrier is computed from the same
measured geometry the edit validates, so a prediction that lands on the wrong
quantum publishes nothing rather than a wrong name.

## Amendment (H01, 2026-11-12): hash-only picks are upgraded wherever they resolve

A pick is stored hash-only when the picked face or edge has no name at pick
time, and step 2 of the resolution order then finds it only while its
selection-time witness survives. On the reported box ∪ cylinder history two
fillets, a chamfer and every face offset from the 37th step on were stored that
way, so any upstream edit that resized their entities failed them. The
amendment above names many such entities after the fact, but a name the body
publishes later never reached a pick already stored.

The app already wrote the name back for two kinds of pick: a fillet or
chamfer's edges and a direct edit's own face (`referenceRepairs`,
`faceReferenceRepairs`, written by `topologyReferenceRepairCommand`). Every
stored face pick now takes the same upgrade: a hole, thicken, thread or
on-body gear face, a shell's opening faces, a draft's faces and a face-distance
edit's opposite face. The rule is unchanged and applies to each:

- only a pick with no v5 reference at all; a face or edge set is upgraded all
  or nothing, and a partial reference list is never extended;
- the stored hash names exactly one face of a single-solid target body, as the
  feature finds that body; the body's lineage publishes a name on that face
  whose `currentHash` is the stored hash and whose witness equals the face's
  measured witness; that name is published on no other face; and two members
  of one set never take the same name;
- the advice is offered only once the feature itself has built.

The upgrade records the name of the entity the hash already resolves to and
leaves the stored hash as it was, so it changes neither the geometry nor what
the pick means; an ambiguous or unnamed pick stays hash-only. After it, an
upstream edit resolves the pick by lineage (step 1).

It is written as before: automatically after a committed rebuild, never from a
preview, validation or drag build, as one atomic `Repair topology references`
normalization that persists and syncs like an edit without an undo step of its
own. Nothing is written for a feature after the first failed or manually
suppressed one (ADR-017, November 2026), where the kernel withholds the advice;
the app draws the same line at the first failed, refused or suppressed step in
history order. Before this the app wrote nothing at all once any feature had
failed, so a model with one unrelated late failure never upgraded its earlier
picks.

A legacy face-attached sketch or datum without a reference is not upgraded: it
replays its stored migration frame instead of resolving a hash, and a reference
would make it start following the face.

The app also says, once per commit and without blocking it, when the commit
stores a new hash-only pick that its own rebuild cannot name, and Diagnostics
notes how many steps hold one. Neither is a warning: the model built as asked.

Names for fillet and chamfer bands and other entities the kernel reports no
construction history for remain the kernel's to supply (see the coverage table
above); this amendment only carries a name the body already publishes.

## Amendment (M14, 2026-11-13): gear edges are named from their two faces

A gear body published a name for every face (the kernel's tooth roles, and
the collar, shoulder and cap roles of partial-span teeth) and for no edge, so
a fillet or chamfer on a gear edge was a hash-only pick that any span, module
or tooth-count edit orphaned.

A gear body's edges are now named at publication
(`exact-gear-edges.ts`): an edge the result solid's own topology puts between
exactly two faces, both named and each name held by one face, is
`gear.edge.between.<face>|<face>`, the two face names in string order. This
is the pair rule `boolean.edge.between.*` already follows, with the pair read
from the built solid rather than from kernel history, so it needs no carrier
check: the adjacency is the claim. Faces the teeth leave on the body count by
their carried names. Tooth edges are named like any other, so they follow
the tooth index their faces carry: `…tooth[3].flank.plus|…tooth[3].tip` is
tooth 3's edge at any tooth count that still has a tooth 3.

Where one pair of faces shares several edges, none is the edge between them.
Each is `….piece.<i>.of.<n>`, ordered along the gear's axis, each edge
standing at the middle of its ends or a closed edge's centre. The count is in
the name, so a reference to one of two pieces cannot resolve to the single
edge an edit leaves, or the reverse. Pieces at one height publish no name:
around the axis there is no origin every edit leaves alone (the gear's x
direction is a parameter, and the blank can be turned under the teeth), so
an angular count could hand one piece's name to its neighbour. That is the
case of a collar's seam cutting the arc it shares with a flush tooth tip in
two, a smooth edge no blend applies to. An edge with an unsupported witness,
and any pair that includes one, publishes no name either. Seams, which bound
one face twice, stay unnamed as on every other body, so a gear body with a
collar or a bore is `partial` for edges and its unnamed edges keep step 2 of
the resolution order; a named edge resolves by name alone.

Nothing in resolution changes. A stored edge name the body no longer
publishes refuses as `reference_missing` ("The selected edge lineage no
longer exists."): teeth run up to an end remove that end's collar and its
rim, and fewer teeth remove the higher tooth indices. Hash-only edge picks
stored on gear bodies before this resolve as before and take the existing
all-or-nothing upgrade once they resolve.

Limits: an edge beside the body's part of a split end cap
(`gear.face.cap.*.body`) is named after that part and so shares its known
limit, refusing once the caps rejoin; and a name is no promise that the
kernel can blend the edge (it refuses a chamfer on a shoulder's rim and both
blends on a cap's edge at one tooth, as geometry, with the edge resolved).

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
  is the first case where that limit was accepted _before_ shipping the
  feature rather than found afterwards; see the Z7 amendment.
- The original spike remains characterization evidence. Production now uses
  only the separately reviewed safe subset; remaining bridge work does not
  block that subset and must not be bypassed with proximity matching.
