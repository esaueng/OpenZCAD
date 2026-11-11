# 1. OpenZCAD reference model

This section describes how OpenZCAD stores a durable pointer to a face, edge
or (indirectly) vertex, and re-finds it on replay. It covers the kernel-neutral resolver
([topology-lineage.ts](../../../packages/kernel-adapter/src/topology-lineage.ts)),
the face-attachment consumer
([face-attachment.ts](../../../packages/kernel-adapter/src/face-attachment.ts)),
the persisted shapes in the document schema, the modules that publish names,
and where the code and ADR-013/ADR-014 disagree. Everything below comes from
the code at the branch head. Points I inferred and did not run are marked
*(inferred)*.

The model has one rule at its centre: **a reference resolves only to exactly
one candidate, and an unproven candidate is a refusal, never a guess.** The
pieces work in this order:

1. **Witness.** Each face or edge is measured into a quantized integer witness.
2. **Hash.** The witness is hashed into an ADR-011 fingerprint.
3. **Name.** The sub-shape gets a lineage name only when a publisher can prove
   the name semantically or through a verified transition.
4. **Reference.** A stored reference carries all three: name, hash and witness.

## 1.1 `topology-lineage.ts` — the kernel-neutral contract and resolver

### Purpose

The header (`topology-lineage.ts:24-31`) defines the module as the ADR-013
contracts, built only from frozen ADR-011 quantized integers. Kernel handles,
traversal positions, tessellation and proximity are left out "so callers cannot
use this module to silently rebind a reference to nearby geometry." It imports
no kernel. Callers pass in measured candidates.

### Identity: witness, hash, name

The persisted types live in `@openzcad/shared` and are re-exported here
(`topology-lineage.ts:1-18`):

```ts
interface TopologyReferenceBaseV5 {          // shared/src/index.ts:423
  producingFeatureId: FeatureId;
  lineageName: string;      // scoped by producingFeatureId
  currentHash: number;      // ADR-011 fingerprint when written
  witnessVersion: 1;
}
// EdgeTopologyReferenceV5 adds kind:'edge', witness: EdgeWitnessV1  (index.ts:432)
// FaceTopologyReferenceV5 adds kind:'face', witness: FaceWitnessV1  (index.ts:437)
```

- **Witness.** `EdgeWitnessV1` (`index.ts:382`) holds the curve type and the
  quantized length. An open edge adds its two endpoints in lexicographic order
  plus a midpoint. A closed edge adds a centre and a canonical axis, or `null`.
  `FaceWitnessV1` (`index.ts:415`) holds the surface type, perimeter, centroid
  (or `null`), an analytic term (plane normal and offset, cylinder axis, foot
  and radius, or `none`) and a u/v closure flag. Coordinates use a `1e-6`
  document-unit grid. Directions use a grid 1000 times finer
  (`DIRECTION_QUANTUM_SCALE`, `topology-lineage.ts:792`).
- **Hash.** `topologyHashOfWitness` (`topology-lineage.ts:488`) runs FNV-1a
  (`fingerprintOfTopologySignature`, `shared/src/topology-reference.ts:9`)
  over a signature string. The edge signature is shared with document ingress
  (`topology-reference.ts:19`). The face signature (`topology-lineage.ts:478`)
  is local and leaves closure out, so two faces that differ only in closure
  share a hash. The full comparison key `topologyWitnessKey`
  (`topology-lineage.ts:536`) does include closure.
- **Name.** `TopologyLineageIdentity` (`topology-lineage.ts:47`) is the pair
  `(producingFeatureId, lineageName)`. The module does not create names. The
  one exception is `importedStepLineageName` (`topology-lineage.ts:524`):
  `import.step.{face|edge}.<hash hex>`, where the name is the fingerprint
  itself.

A "lineage record" is therefore just the `TopologyReferenceV5` value. No
separate transition log or tombstone store exists. While a build runs, the
current names for a body live in an in-memory
`RemusLineageState { faceReferences: Map<handle, ref>, edgeReferences, diagnostics }`
(`remus-lineage.ts:63`). That state hangs off `ExactShape.lineage`
(`exact-types.ts:30`) and is keyed by transient kernel handles.

### Operation capability table

`OPERATION_CAPABILITIES` (`topology-lineage.ts:84-210`) classifies 17 operations:

| Status | Operations |
| --- | --- |
| `semantic` | `primitive`, `sweep` |
| `derived` | `imported-step`, `rigid-transform`, `pattern`, `boolean`, `fillet` |
| `unsupported` (hash-only) | `imported-mesh`, `mirror`, `split`, `hole`, `shell`, `solid-offset`, `draft`, `thicken`, `chamfer`, `direct-edit` |

The comments on `pattern` and `boolean` (`:146-196`) are the most current
prose for the derived rules. Only tests call `topologyLineageCapability`
outside this file, and §1.5 shows the table describes intent, not behaviour.

### Witness validation

`inspectTopologyWitness` (`topology-lineage.ts:436`) returns `supported`,
`invalid` (non-integer points, non-canonical order or signs, a surface type
that disagrees with its analytic kind; `:410-423`) or `unsupported` (closed
B-spline/NURBS edges, and B-spline/NURBS faces not `open` in both directions;
`:329-334`, `:424-431`).

### Verifying evolution (`verifyTopologyEvolution`, `topology-lineage.ts:1079`)

The function receives a source witness, a result witness and one claimed
`EvolutionRelation` (`topology-lineage.ts:707`):

- `unchanged`: the two witnesses must be exactly equal.
- `known-transform`: allowed only for `rigid-transform` and `pattern`. The
  caller's `expectedResultWitness` (the source witness carried through the
  document transform) must be *nearly* equal to the measured result, within
  ±2 quanta per integer (`KNOWN_TRANSFORM_QUANTUM_SLACK`,
  `topology-lineage.ts:575`; `topologyWitnessesNearlyEqual`, `:650`). The
  near-match also accepts the endpoint-swap and sign-flip noise that rounding
  can introduce (`:597-608`, `:675-683`).
- `analytic-carrier`: allowed only for `boolean` and `fillet`. The plane or
  cylinder must match exactly (`analyticCarriersEqual`, `:751`).

`chamfer` and `direct-edit` short-circuit to the capability table's
`unsupported` result (`:1082-1091`).

Boolean and modifier publishers in `remus-lineage.ts` also use carrier
helpers: `edgeLiesOnFaceCarriers` (`:838`, within 4 quanta),
`straightEdgePositionOnSource` (`:913`) and `orderPiecesAroundCylinderSeam`
(`:994`, which declines within `1e-3` rad of the seam or another piece). These
are the design's only "geometric matching". They verify a claimed relation and
never search for a nearest candidate.

### Resolution (`resolveTopologyReference`, `topology-lineage.ts:1358`)

```ts
resolveTopologyReference(
  reference: TopologyReferenceV5 | LegacyTopologyHashReference,
  candidates: readonly TopologyResolutionCandidate[],   // kind, currentHash, witness, lineage?, value?
  lineageAvailability: LineageAvailability = { status: 'available' }
): { status: 'resolved'; via: 'lineage' | 'hash-fallback' | 'legacy-hash'; candidate }
 | { status: 'failed'; reason: TopologyResolutionFailureReason; message }
```

The algorithm runs in this order:

1. `currentHash` must be a positive safe integer.
2. A **legacy** `{ kind, currentHash }` reference (`:42`) resolves by unique
   hash only (`via: 'legacy-hash'`).
3. For a v5 reference, the identity must be non-empty, the stored witness must
   inspect as `supported`, and re-hashing the witness must reproduce
   `currentHash`. Otherwise the result is `invalid-reference` or
   `unsupported-witness` (`:1376-1408`).
4. If the caller passes `lineageAvailability: unsupported`, resolution is by
   hash **and** exact witness equality (`resolveByHash`, `:1313`;
   `via: 'hash-fallback'`).
5. Otherwise the resolver filters candidates with the same kind and identity
   (`namedCandidates`). It keeps those whose own witness re-hashes to their
   `currentHash` (`candidateInspection`, `:1273`). A `kernel-evolution`
   candidate must also carry a `verified` result bound to its witness
   (`kernelEvolutionIsBound`, `:1296`).
6. One survivor resolves. More than one gives `ambiguous-lineage`. Named
   candidates with no survivor give `lineage-unverified`. No named candidate
   gives `lineage-not-found`. **A v5 lineage failure never falls through to the
   hash** (doc comment `:1353-1357`).

During lineage resolution the stored witness is deliberately **not**
compared with the candidate, since ADR-013 lets a lineage evolve. It serves
only integrity, hash fallback and diagnostics.

### Failure reasons and determinism

`TopologyResolutionFailureReason` (`:1229`) has seven values:
`invalid-reference`, `unsupported-witness`, `lineage-not-found`,
`lineage-unverified`, `ambiguous-lineage`, `hash-not-found` and
`ambiguous-hash`.

The shared `TopologyLineageDiagnostic` (`shared/src/index.ts:2944`) has these
statuses: `hash-only`, `deleted`, `split`, `merged`, `ambiguous` and
`unsupported`. The Remus publisher has 18 finer codes
(`remus-lineage.ts:33-51`), for example `transform-split`,
`boolean-evolution-disagreement` and `pattern-kernel-declined`.

Determinism rests on integer comparison (apart from the documented slack
bands), names derived from document data or exact witnesses, and uniqueness
gates that turn any tie into a failure. Because the resolver counts matches
rather than taking the first, candidate order cannot change the outcome.

## 1.2 `face-attachment.ts` — attaching to a resolved face, edge or vertex

### What a face attachment is

It is a sketch, datum or extrude target that is fixed to a planar model face at
its own history position (ADR-014). The persisted form is the `face` variant of
`SketchPlaneRef` (`shared/src/index.ts:815-838`):

- `bodyId`
- `faceHash`
- an optional `faceReference: FaceTopologyReferenceV5`
- a snapshot: `sourceArea`, `sourceCenter`, `sourceNormal`, the selection-time
  `frame`, and an optional `sourceCentroid`

In code the snapshot is `FaceAttachmentSnapshot` (`face-attachment.ts:55`). It
never decides which face resolves. It does two things:

- **Orientation.** It orients the rebuilt frame.
- **Anchor.** The *presence* of `sourceCentroid` chooses the anchor point:
  the area centroid when present, the vertex mean when absent.

### `resolveFaceAttachment` (`face-attachment.ts:307`)

1. Call `resolveTopologyReference` with lineage available. Map its failure
   reasons onto `deleted | ambiguous | non-planar | invalid | unsupported`
   (`mappedFailureReason`, `:120`). Note that `lineage-unverified` maps to
   `unsupported`.
2. Reject any result that did not come `via: 'lineage'` (`:322`).
3. Require the face to be an exact plane with plane data (`:339-349`).
4. If the snapshot has `sourceCentroid` but the resolved face reports no
   centroid, **fail**. Re-anchoring on the vertex mean would move the sketch by
   up to a radius (`:350-359`).
5. Build the frame with `deterministicFrame(anchor, normal, snapshot.frame)`
   (`:257`):
   - The canonical normal is flipped to keep the stored `zAxis` sense.
   - The stored `xAxis` is projected onto the new plane.
   - Below `SEED_DEGENERATE_LIMIT = 1e-3` (`:211`), it falls back to the
     least-aligned world axis.

Every rebuild seeds from the persisted frame, never from the previous rebuild,
so the frame cannot drift.

Failures throw `FaceAttachmentResolutionError` (`:81`), naming owner, source
feature and snapshot (`:107-118`).

### Siblings for R01 datums

- **`resolveEdgeVertex` (`:409`).** A vertex is addressed as end `0 | 1` of a
  lineage-resolved open edge. The end order is quantized lexicographic
  (`edgeEndPoint`, `topology-fingerprint.ts:149`). When native vertex evidence
  is present, it must be `qualified` and must quantize to the same point,
  otherwise the call refuses (`:439-455`). Which native slot it reads is
  decided by object identity, `point === candidate.endpoints[0]` (`:438`).
- **`resolveDatumAxisEdge` (`:502`)** requires a straight `LINE`.
  **`resolveDatumAxisFace` (`:546`)** requires an exact cylinder or cone axis.
  Both use `lineageCandidate` (`:463`), which is lineage-only.

### Split and disappearance

No function handles a split face specially. Two candidates with one name give
`ambiguous`; a withheld name (the normal case, e.g. `transform-split` or
`boolean-split-source`) gives `deleted`. So "deleted" and "split, name
withheld" read the same.

### Callers and legacy handling

Callers are sketch, datum, Mirror and Split plane resolution
(`exact-profile-builders.ts:344`), edge vertices and datum axes (`:405`,
`:443`, `:451`), the extrude `to-face` target (`extrude-options.ts:85`) and the
UI sketch basis (`apps/web/src/lib/sketch/planeBasis.ts:73`). A `face` plane ref *without* `faceReference` keeps using its stored frame and
emits a warning: "legacy face attachment has no schema-v5 lineage reference;
using its stored migration frame" (`exact-profile-builders.ts:322-330`).

## 1.3 How references are persisted

### Reference holders

In the table, `faceHash` / `edgeHashes` is the ADR-011 hash and is always
present. The `*Reference` fields are the optional v5 anchor unless marked
**required**. Lines are in `packages/shared/src/index.ts` unless another file
is named.

| Holder | Fields | Introduced |
| --- | --- | --- |
| Sketch plane `face` (`:815-838`) | `faceHash`, `faceReference?`, snapshot, `sourceCentroid?` | v5 reference (ADR-013/014); centroid marker later, no bump noted |
| Datum plane face source `FacePlaneSource` (`:851`) | `faceReference` and `sourceCentroid` **required** | v19 (`:71`) |
| Extrude `toFace: ExtrudeToFaceTarget` (`:861`, `:1661`) | same as `FacePlaneSource` | v29 (`:128`) |
| Datum point `EdgeVertexPointSource` (`:874`) | `edgeReference` **required**, `end: 0 \| 1` | v25 (`:99`) |
| Datum axis `DatumAxisEdgeSource` / `DatumAxisFaceSource` (`:931`, `:941`) | `edgeReference` / `faceReference` **required** | v28 (`:120`) |
| Sketch projection `SketchProjectionSource` (`:1441`) | `edgeReference` **required** | v33 (`:159`) |
| Direct edit, ten operation kinds (`:523-666`) | `faceHash`, `faceReference?`; `set-face-distance` adds `oppositeFaceHash` and `oppositeFaceReference?` (`:612-615`) | additive |
| Hole (`:1816`), thicken (`:2117`), thread (`:2032`, v53) | `faceHash`, `faceReference?` | per feature |
| Gear on a cylinder (`:2003-2004`) | `faceHash?`, `faceReference?` | v40+ |
| Shell (`:2094`) / draft (`:2108`) | `openingFaceHashes` + `openingFaceReferences?` / `faceHashes` + `faceReferences?` | per feature |
| Fillet (`:2124`) / chamfer (`:2147`) | `edgeHashes`, `edgeReferences?` | per feature |
| Drawing `DrawingEdgeRef` / `DrawingFaceRef` (`drawing-annotations.ts:54-69`) | `hash`, `reference?` | v31 edges, v48 faces |
| Reference image on a planar face (`reference-images.ts:249-258`) | `SketchPlaneRef` face variant | v32 (`:149`) |
| Recognised imported feature (`:2402-2403`) | `seedFaceHash`, `seedFaceReference?` | derived state |

`FaceTopology.reference` / `EdgeTopology.reference` (`:2376`, `:2637`) and
`TopologySelection.reference` (`:2953`) are projection and selection state, not
persisted. `RuntimeVertexReference` (`:2820`) is runtime-only. Its comment says
it is "deliberately outside TopologyReferenceV5 and the document schema."

### Schema version and migration

`PROJECT_DOCUMENT_SCHEMA_VERSION` is 54 (`index.ts:222`). The v4 → v5 step is
**purely additive**. `normalizeDocument` writes nothing new. Its comment says
existing hashes and exact source geometry "remain the fail-closed fallback
until a feature writes a lineage reference"
(`document-core/src/index.ts:1058-1064`). No code rewrites hash-only selections
into v5 references at load.

Legacy references are upgraded only at runtime. A hash-only fillet or chamfer
whose every edge resolves to a lineage-proven reference with the same hash
emits `EdgeReferenceRepair` (all-or-nothing;
`exact-reference-resolution.ts:119`); direct edits emit `FaceReferenceRepair`
(`index.ts:3290`); `topologyReferenceRepairCommand`
(`apps/web/src/lib/topologyReferenceRepairs.ts:10`) applies both as one
command after a fully clean replay. Legacy face sketches are not upgraded:
they warn and offer conversion to a fixed `frame` plane
(`faceSketchAttachment.ts:141`).

Separately, the hash-only path accepts a **pre-ADR-011 Remus face
fingerprint** as an alias (`legacyFaceFingerprint`, `exact-witnesses.ts:496`,
registered by `faceHandlesByFingerprint`, `:519`). It is based on an area
measured at a tessellation deflection.

### Where stored references are validated

Each entry point checks something different. Command authoring checks hash
agreement and edge uniqueness (`command-system/src/index.ts:872`, `:887`).
Drawing annotations check shape, witness and hash (`drawing-annotations.ts:404`).
Sketch projections re-hash the witness (`isCanonicalEdgeTopologyReference`,
`topology-reference.ts:105`). Reference images only check that
`faceReference` is a record (`reference-images.ts:253`). There is no
`isCanonicalFaceTopologyReference`, and `shared/src/document-validation.ts`
does not check feature-held references, so otherwise the witness is re-hashed
only at resolve time.

## 1.4 How the modules connect

**`remus-lineage.ts`** is the Remus-specific publisher, turning kernel handles
plus evidence into `RemusLineageState`. `createRemusSemanticLineage` (`:130`)
publishes a name only when name and handle are one-to-one.
`propagateRemusRigidTransformLineage` (`:1732`) keeps identity through a
transform and replaces only witness and hash. `deriveRemusPatternInstanceLineage`
(`:563`) names copies `pattern.face.instance.<n>.<source>`. Booleans are
derived twice, by carrier (`:225`) and by kernel entity evolution (`:2214`),
and `reconcileRemusBooleanLineage` (`:2625`) withholds both names when they
disagree. `createRemusModifierEvolutionLineage` (`:1320`) names blend bands
`modifier.<op>.face.band-between.<a>|<b>`.

**`exact-lineage-builders.ts`** builds semantic names from construction inputs:
`primitive.box.face.x-min` (`buildPrimitiveLineage`, `:636`), and
`sweep.face.cap.start.<objectId>`, `sweep.face.side.<objectId>.<index>` and
`sweep.edge.*` for extrude and revolve (`:1321`, `:1455`).
`addUniqueSemanticAssignment` (`:571`) is the exactly-one-match gate.

**`exact-operation-lineage.ts`** holds helpers that skip
`verifyTopologyEvolution`: `carryAnalyticFaces` (`:27`) keeps a name when the
witness or carrier is unique before and after, `withBoundaryEdgeLineage`
(`:116`) names `boundary.edge.[<idA>,<idB>]` from two uniquely named faces,
and `holeLineage` (`:182`) publishes `hole.face.bore` and its siblings.
Fillet/chamfer (`exact-feature-builders.ts:2568`) and direct edits
(`exact-direct-edit-ops.ts:1718`) also use these helpers.

**`exact-idle-lineage-view.ts`** keeps a second lineage view of the *same*
checkpoint geometry: the names that would exist with an empty boolean-probe
demand (`:1-5`; `IdleLineageViewBuilder`, `:125`; supported features in
`supportsIdleLineageView`, `:51`). An unaudited path calls `abandon()`, and a
recomputed boolean sets `diverged`. This lets a cached checkpoint serve the
idle state without a rebuild.

**`apps/web/src/lib/lineageDemand.ts`** is transient UI state. It holds the set
of body ids whose producing booleans must run the costly entity-evolution probe
(`:5-17`). The set is sticky for the open project and is cleared when the
project changes (`useLineageDemand`, `:101`). It is never persisted. It enters
the rebuild cache key. The kernel side, `booleanEvolutionProbeNeeded`
(`exact-boolean-evolution.ts:689`), also forces the probe when a *persisted*
reference names the boolean as its producer (`persistedReferenceNamesProducer`,
`:546`), so replay does not depend on demand for references it knows about.

A **second resolver**, `apps/web/src/lib/topologyResolution.ts`, serves
measurements, drawing annotations, labels and datum-vertex repair under
different rules (see §1.5).

## 1.5 Divergence from ADR-013 and ADR-014

**ADR-013** ([ADR-013](../../adrs/ADR-013-persistent-topology-lineage.md)):

1. **Coverage text is stale in both directions.** The "Gate decision"
   section (`ADR-013:275-285`) still lists patterns and blends as "no lineage
   — hash fallback only", while the code marks `pattern` and `fillet`
   `derived` (`topology-lineage.ts:146-197`). Conversely `hole`, `chamfer` and
   `direct-edit` are `unsupported` in the table yet publish names
   (`holeLineage`; `exact-feature-builders.ts:2545-2565`;
   `exact-direct-edit-ops.ts:1718-1740`).
2. **No lineage tombstones.** ADR-013 says "A validated deletion writes a
   lineage tombstone naming the deleting feature" (`:160-162`). Nothing in the
   kernel adapter does this. A deletion shows up only as a missing name, which
   is `lineage-not-found`. The error therefore cannot name the deleting
   feature.
3. **No explicit transition chain.** Resolution step 1 ("rebuild and validate
   the lineage transition chain", `:255`) is implicit. Each publisher's
   per-step checks stand in for the chain. The resolver itself sees only the
   final name→handle map.
4. **Uniform scale.** ADR-013 allows only rigid transforms.
   `propagateRemusRigidTransformLineage` accepts a uniform-scale matrix when
   the modifier chain's root is a box or cylinder primitive
   (`exact-feature-builders.ts:1160-1163`).
5. **The `kernel-evolution` candidate source is unused in production.** Every
   production candidate builder labels lineage `semantic` or `derived`
   (`exact-reference-resolution.ts:52`, `:171`; `exact-direct-edit-ops.ts:214`;
   `exact-shape-utils.ts:134`), so `kernelEvolutionIsBound` runs only in tests
   and verification happens at publish time instead.
6. **Vertices.** ADR-013 says vertices are "deliberately outside this
   contract" (`:195-196`). Schema v25 added persistent vertex sources as an
   edge plus a quantized end index, and native vertex evidence now
   participates in resolution (`face-attachment.ts:436-455`).
7. **UI hash fallback.** ADR-013 makes a v5 lineage miss terminal (`:255-260`).
   The web resolver deliberately falls through from a lineage miss to the
   hash (`topologyResolution.ts:118-139`). Its hash rung also matches on the
   projection `topologyId` (`:106-117`), which is close to the "viewport ID"
   that ADR-013 rules out as an identity, and it skips the witness check.
8. **Stale pointers.** The Z7 amendment cites a constant in `exact.ts` that now
   lives at `exact-profile-builders.ts:154`.

**ADR-014** ([ADR-014](../../adrs/ADR-014-true-face-attachment.md)):

1. **Hash-only faces still accept sketches.** ADR-014 says "Sketch is disabled
   with an explicit explanation" (`:101-106`). `faceSketchAttachment` instead
   places the sketch on a fixed frame coincident with the face and returns a
   `note` (`faceSketchAttachment.ts:10-21`, `:93-109`).
   `UNSTABLE_FACE_SKETCH_REASON` also says boolean faces always lose identity,
   which stopped being true once boolean carrier lineage shipped.
2. **Anchor point.** ADR-014 derives the frame from the "current face center"
   (`:41`). The code anchors on the area centroid whenever `sourceCentroid` is
   present, and fails closed if the centroid is missing (`face-attachment.ts:350-362`).
3. **Scope.** The resolver now also serves datum planes, datum axes,
   edge-vertex points, extrude `to-face` and reference images. Error
   ownership is labelled accordingly (`ownerKind`). Mirror and Split owners
   are reported as "Datum plane" (`exact-profile-builders.ts:357-360`).
4. The 2026-08-25 frame amendment and legacy-to-fixed conversion match the
   code.

## 1.6 Open questions for the review

1. **Is a demand-dependent name stable?** `booleanEvolutionProbeNeeded`
   enumerates persisted holders by hand (`exact-boolean-evolution.ts:546-625`).
   The list leaves out the extrude `toFace` target, drawing annotation refs and
   reference images. *(Inferred)* A reference to a face that only the
   evolution probe names (a shared or split carrier) could resolve during
   editing, because the UI demand is set, and then fail with
   `lineage-not-found` after a reload. No probe test covers `toFace`
   (`test/boolean-evolution-*.test.ts`).
2. **Can reconciliation withdraw a name that already exists?** A reference
   written while only the carrier rule ran becomes `lineage-not-found` if a
   later forced probe disagrees and `reconcileRemusBooleanLineage` withholds
   both names (`remus-lineage.ts:2625-2668`). Is that refusal the intended
   user experience, and is it tested?
3. **Capability table versus publishers.** `OPERATION_CAPABILITIES`
   (`topology-lineage.ts:84`) is not consulted by the publishers, and it
   contradicts them for hole, chamfer and direct-edit. Should it be made
   authoritative, or deleted?
4. **Sweep side-face names use the profile segment index**
   (`sweep.face.side.<objectId>.<index>`, `exact-lineage-builders.ts:1421`).
   *(Inferred)* Inserting a vertex into a polygon renumbers every later side,
   which silently re-targets downstream references to a *different* valid
   face. This is the classic naming failure, and uniqueness checks cannot
   catch it.
5. **Vertex identity is geometric.** `end: 0 | 1` is the lexicographically
   first quantized endpoint (`topology-fingerprint.ts:149-163`). *(Inferred)*
   An upstream rotation that reverses that order makes the datum switch to the
   other vertex without any error. The native slot is also chosen by object
   identity (`face-attachment.ts:438`), which is an implicit contract with
   `edgeEndPoint`.
6. **Blend support identity drops the producer.** `supportIdentity` returns
   only `lineageName` (`remus-lineage.ts:1311-1313`). Supports from different
   features that share a name collapse together and fail closed, so names are
   lost. The band name also does not encode the supports' producers.
7. **Hash fallback when lineage is absent.** A v5 direct-edit reference on a
   shape with no `lineage` falls back to hash plus witness
   (`exact-direct-edit-ops.ts:226-231`). Multi-solid edge-modifier bodies do
   the same, reported as operation `'fillet'` even for chamfer
   (`exact-reference-resolution.ts:205-210`). When can `lineage` be undefined
   on a v5-referenced body?
8. **Ingress validation is uneven** (§1.3). Face references are never
   re-hashed before replay. Reference images accept any record. The resolver
   catches a bad reference, but only as a build-time `invalid-reference`.
9. **Repair detection is coupled to message text.** `staleDirectEditFaceRepair`
   matches warning strings with regexes (`document-core/src/index.ts:5117-5123`).
   Changing a resolver message would silently disable the repair path.
10. **Split and deleted read the same** (§1.2), and the face hash omits
    closure, so closure-only twins rely on the key comparison (`:478-486` vs
    `:543-555`).
