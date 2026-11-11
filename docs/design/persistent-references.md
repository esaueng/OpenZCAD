# Persistent references: design

Status: proposed. Input: the briefing pack in
[docs/briefings/naming/](../briefings/naming/README.md) only (OpenZCAD
`c73dccff3`, schema 54; Remus `087d6360`). Pack sections are cited as §n.m.
Nothing here was verified against source or by running code; every unverified
dependency is listed in [§7](#7-assumptions-and-experiments) with the
experiment that settles it.

## 0. Decisions

1. **Identity spine.** OpenZCAD owns identity. A name is a pure function of
   the document and a versioned rule set. Remus journal ordinals,
   `PersistentRef`s and `OperationOutput` indices are never stored and, after
   the migration, never read.
2. **Kernel role.** Every Remus operation returns one total,
   construction-derived evolution record (`EvolutionRecordV2`) from the call
   that produces the shipped geometry. Construction claims are trusted after
   structural checks, not re-derived from witnesses.
3. **One naming algebra.** One function applies a record to a lineage graph
   with five rules (carry, split, merge, birth, delete). No shape exists
   without passing through it.
4. **Splits and merges resolve by consumer arity,** not by refusal.
5. **One stored identity.** A v6 reference is name + witness; the hash is
   derived; the witness never selects a candidate in the modelling path.
6. **One resolver, two policies:** `strict`, and `display` for an allowlist
   of transient UI readers.
7. **Lost references are typed and repairable** through one re-pick flow.

## 1. Diagnosis

The 20 incidents in §4 are symptoms of one structural fact:

> **Identity is reconstructed downstream, per feature, from a snapshot of a
> body the kernel did not describe, and nothing obliges that reconstruction to
> be total.**

Four properties of the current design follow from it, and each explains a
family of incidents.

1. **Naming is opt-in, so the default for an unaccounted entity is silence,
   and silence degrades to a dimension-dependent hash.** A name exists only
   where someone wrote a publisher for that operation, entity kind and
   topological case (§1.4). Coverage is therefore the product of operations ×
   kinds × cases, and a gap is invisible until an upstream edit moves the
   hash. Incidents 4, 5, 11, 12, 17 and 20 each closed one cell. Nothing fails
   when a new cell opens: `OPERATION_CAPABILITIES` is not consulted by the
   publishers and contradicts them (§1.5), and Remus has no check that an
   emitter recorded a source (§4 pattern 1).
2. **Lineage and geometry come from different calls.** The shipped `*Detailed`
   paths emit no lineage; booleans are probed on copies and describe a 14-face
   body where the shipped one has 6 (§2.3, §2.10). The adapter must therefore
   match kernel claims back onto the shipped body by witness. That matching is
   where twins, shared carriers and splits are lost, and it is why two
   derivations of one boolean can disagree (`reconcileRemusBooleanLineage`).
3. **The system stores a final name→handle map, not transitions.** With no
   transition record there is no tombstone, so split, merged, deleted and
   never-tracked all surface as `lineage-not-found` (§1.2, §1.5). Refusal is
   then the only safe answer, and the only repair is a feature-specific UI
   (incidents 13, 16).
4. **Published identity depends on things outside the document:** probe
   demand, cache mode, arena handles, operand slots, traversal order,
   coordinate order (incidents 14, 15, 19; §1.6 items 1, 4, 5). Each was fixed
   individually; the class is still open because a publisher can read any
   session state it likes.

Two secondary causes sit on top: a reference stores two identities (hash and
name) that can disagree (incidents 10, 18), and the UI has its own resolver and
geometric rebinding (incidents 1, 6, 7).

The fix is not more publishers. It is a totality obligation at one choke point
in each repo, and a naming rule that needs no per-feature judgement once the
kernel reports what it did.

## 2. Reference model

### 2.1 Entity names

A name is a canonical string with this grammar. It is defined in a new pure
module `packages/shared/src/entity-name.ts` (parse, encode, validate).

```text
Name   := Birth Step*
Birth  := featureId ":" role "(" Arg ("," Arg)* ")"      // args sorted unless the role says ordered
Arg    := Name | "#" hex16 | token                          // token: sketch entity id, instance key, hash
Step   := "/" featureId "[" Disc "]"
Disc   := "g:" hex16 | "n:" hex16 | "o:" k "/" n | "t:" n
```

- **Birth** names the feature that created the entity and its construction
  role, from a frozen vocabulary (§3.3). Arguments are document data (sketch
  entity ids, instance keys) or names of source entities in the feature's
  *input*.
- **Step** is appended only when a later feature splits the entity.
- An entity that passes through a feature unchanged, moved or trimmed keeps its
  name verbatim. A box face still reads `f12:box(x-min)` after three booleans,
  so **operand slots disappear from names**.
- **Length cap.** If an encoded name exceeds 1,024 bytes, each `Arg` that is a
  `Name` is replaced, innermost first, by `#` + FNV-1a 64-bit hex of its full
  encoding until it fits. A digest collision yields two holders of one name
  and fails closed.
- Vertices are first-class and use the same grammar.

### 2.2 Stored reference

```ts
// packages/shared/src/index.ts, beside TopologyReferenceBaseV5
interface TopologyReferenceV6Base {
  refVersion: 6;
  name: string;            // canonical EntityName; the only identity
  nameRules: 1;            // naming rule-set version that produced it
  pick?: string;           // a Disc chosen by the user among split pieces (§2.5)
}
// Face/Edge: + kind, witness: FaceWitnessV1 | EdgeWitnessV1, witnessVersion: 1
// Vertex:    + kind: 'vertex', witness: { point: [int, int, int] }, witnessVersion: 1
```

- `currentHash` is gone; a hash is `topologyHashOfWitness(witness)`. The
  sibling `faceHash`/`edgeHashes` fields stay in the schema, are written as
  that derived value, and are ignored by resolution when a reference exists.
- **The witness is not identity.** `strict` resolution never compares it with
  a candidate. It serves ingress validation, the repair UI, display policy
  and migration.
- `producingFeatureId` is subsumed by the birth feature inside `name`.

### 2.3 Lineage graph

`RemusLineageState` is replaced by a kernel-neutral, per-body value in a new
`packages/kernel-adapter/src/lineage-graph.ts`:

```ts
interface LineageGraph {
  entities: Map<handle, { kind; names: string[]; witness }>;  // names[0] primary, rest aliases, sorted
  tombstones: Map<string, { by: FeatureId; cause: 'deleted' | 'consumed' }>;
  splits: Map<string, { by: FeatureId; pieces: string[] }>;   // parent name -> piece names
  gaps: { by: FeatureId; kind; count: number; reasons: string[] }[];
}
```

It hangs off `ExactShape.lineage` as today, but it is never `undefined`
(closing §1.6 item 7). It is built only by:

```ts
applyEvolutionRecord(inputs: LineageGraph[], featureId, record: EvolutionRecordV2,
                     measured: MeasuredBody, roles: RoleBinding): LineageGraph
```

### 2.4 The five rules

`applyEvolutionRecord` runs four passes. Rules are stated per event (§3.1).

| Pass | Event | Rule |
| --- | --- | --- |
| 1 | `preserved` / `modified`, source claimed by exactly one result | Result takes all the source's names unchanged |
| 1 | `merged{from[]}` | Result takes the sorted union of the sources' names (aliases) |
| 1 | `copied{from, instance}` | Birth `X:copy(<instance key>, <source name>)` |
| 2 | `modified`, source claimed by n ≥ 2 results | Provisional `S/X[?]` for each of the source's names; record `splits[S]` |
| 2 | `generated{sources, role}` | Provisional birth `X:role(source names)`; role defaults to `between` (edges, faces) or `corner` (vertices) |
| 2 | source in `deleted` | Tombstone `deleted` for each of its names |
| 2 | source claimed by nothing, not `deleted` | If the record has zero `unresolved` events of that kind: tombstone `consumed`. Otherwise no tombstone and a `gaps` entry |
| 3–4 | groups sharing a provisional name | Disambiguate (below) |
| 4 | `unresolved` | Apply the two generic inference fillers below; else no name, `gaps` entry |

The `consumed` rule is the answer to the deletion-spelling question (§2.11
item 6): Remus never synthesises `deleted`; OpenZCAD derives consumption, and
only from a total record, where set difference is sound.

**Disambiguation of a tied group** (pieces of one split, or generated entities
with one birth name), in order, stopping at the first tier that separates every
member:

- **`g:`** digest of the sorted multiset of provisional names of adjacent
  entities *generated by X* (the cutting entities), minus names adjacent to
  every member.
- **`n:`** the same over all adjacent entities.
- **`o:k/n`** a carrier order from the existing order functions
  (`orderPiecesAroundCylinderSeam`, `straightEdgePositionOnSource`), which
  already decline near ties. `n` is encoded so a count change cannot retarget.
- **`t:n`** tied class. Members share one name and are addressable only as a
  set.

Adjacency is face–edge and edge–vertex incidence in the result body. One round
only; no fixpoint.

**Generic inference fillers** (the only inference in the system, both marked
`inferred` in `gaps` accounting so the ledger sees them):

1. An `unresolved` result whose witness key equals exactly one input entity's,
   where that input is claimed by nothing else, is treated as `preserved`.
2. An `unresolved` edge that is the only edge between two named result faces is
   born `X:between(nameA, nameB)`; a vertex likewise as `X:corner(...)` over
   its incident faces.

These replace `carryAnalyticFaces`, `withBoundaryEdgeLineage` and the carrier
rule, for every operation at once.

**Name stability rule.** Any change (kernel or adapter) that alters a published
name for an unchanged document must add an entry to a `COMPAT_ALIAS_RULES`
table in `lineage-graph.ts` that re-publishes the old name as an alias, and a
golden document proving it (§5 T9). This is what makes a kernel upgrade that
turns an inferred birth into a `preserved` claim safe.

### 2.5 Resolution

New `packages/kernel-adapter/src/reference-resolution.ts`:

```ts
resolveReference(ref, graph, { arity: 'single' | 'set' | 'carrier', policy: 'strict' | 'display' })
  -> { status: 'bound', entities, note?: 'widened' | 'merged' | 'pieces' }
   | { status: 'split', by, pieces }          // single consumer, several pieces
   | { status: 'deleted', by, cause }
   | { status: 'not-produced', by }           // birth feature ran, no such role
   | { status: 'source-missing', by }         // birth feature absent or suppressed
   | { status: 'untracked', by }              // a gap lies between birth and here
   | { status: 'invalid', reason }
```

Algorithm, `strict`:

1. Validate grammar and witness canonical form, else `invalid`.
2. **Exact.** Entities holding `ref.name` (primary or alias). One → `bound`
   (`note: 'merged'` if it holds other aliases with a different birth). Several
   → a tied class; go to step 5 with those as pieces.
3. **Descendants.** Entities whose name is `ref.name` followed by steps. If
   any: pieces = those entities; go to step 5.
4. **Ancestor.** Strip trailing steps one at a time. If the shortened name is
   held by exactly one entity → `bound`, `note: 'widened'` (the split no longer
   happens). If instead it has descendants with other discriminators →
   `split` with those pieces. Otherwise consult, in order: `tombstones` for
   the name or any prefix → `deleted`; the birth feature's presence →
   `source-missing`; whether it produced the role → `not-produced`; any
   `gaps` entry of this kind on this body's history → `untracked`. Anything
   left is `untracked` with `by` = the consumer's predecessor (an internal
   error, counted by telemetry).
5. **Arity** over a piece set:
   - `set`: `bound` with all pieces, `note: 'pieces'`.
   - `carrier`: if all pieces have equal analytic terms (plane or
     cylinder/cone axis and radius) → `bound` with all pieces; the caller
     derives one carrier. Otherwise `split`.
   - `single`: if `ref.pick` equals exactly one piece's last `Disc` → that
     piece. Otherwise `split`.

`display` policy differs only after a non-`bound` result: it may return a
unique candidate whose witness key equals the stored witness, labelled
`via: 'witness'`. It never matches `topologyId` across builds.

v5 and legacy hash-only references keep resolving through the existing
`resolveTopologyReference`, unchanged, until upgraded (§4).

**Arity per holder** (authoritative; implement as a constant table next to the
reference walker of §4.1):

| Arity | Holders |
| --- | --- |
| `set` | Fillet/chamfer `edgeReferences`; shell `openingFaceReferences`; draft `faceReferences`; sketch projection `edgeReference` |
| `carrier` | Sketch plane `face`; `FacePlaneSource`; `ExtrudeToFaceTarget`; `DatumAxisEdgeSource`; `DatumAxisFaceSource`; reference image plane; hole, thread and gear target face |
| `single` | All ten direct-edit kinds including `oppositeFaceReference`; thicken; datum point vertex; drawing edge/face refs; recognised-feature seed face |

For a `carrier` plane over several pieces, `resolveFaceAttachment` anchors on
the area-weighted centroid of all pieces. That is continuous as a split opens
from zero width, so a sketch does not jump when a slot first cuts its face.

### 2.6 What the user sees

A consumer whose reference does not bind fails as today, but the message and
actions come from the typed status, never from text matching (§1.6 item 9):

| Status | Message (pattern) | Actions |
| --- | --- | --- |
| `deleted` | "The *edge* this fillet used was removed by *Cut 3*." | Re-pick, Go to *Cut 3*, Suppress |
| `split` | "*Cut 3* split this face into 2 pieces." Pieces highlighted | Choose piece (stores `pick`), Re-pick |
| `not-produced` | "*Sketch 2* no longer has the segment that made this face." | Re-pick, Go to feature |
| `source-missing` | "*Extrude 1* is missing or suppressed." | Unsuppress, Re-pick |
| `untracked` | "OpenZCAD could not follow this edge through *Shell 1*." | Re-pick; counted as a coverage defect |
| `invalid` | "This reference is damaged." | Re-pick |

Re-pick is the datum flow generalised (incidents 13, 16): staged, preflighted,
one undoable command, other parameters kept. The stored witness draws a ghost
at the last known position and ranks candidates by witness distance. **Ranking
is a suggestion only; nothing binds without a click.** This is the single
place proximity is allowed.

A `note` on a `bound` result is an informational chip on the History row
(`widened`, `merged`, `pieces: 4`), not a warning.

Consumed inputs (incidents 1, 8): each feature's build result publishes
`resolvedInputs`, the entities its references bound to on its *input* body.
History summaries and edit-mode remapping read that, not the current body.

## 3. Remus–OpenZCAD contract

### 3.1 `EvolutionRecordV2`

One shape, converging the four in §2.0 on the result-aware F/E/V payload of
§2.5. It is returned in-band by the geometry call; OpenZCAD consumes nothing
else.

```ts
interface EvolutionRecordV2 {
  schemaVersion: 2;
  inputs:  { solid: number; faces: number[]; edges: number[]; vertices: number[] }[]; // argument order
  results: { solid: number; faces: number[]; edges: number[]; vertices: number[] }[];
  events:  Event[];                                   // exactly one per result entity
  deleted: { kind: Kind; entity: number }[];          // construction-recorded only
}
type Event = { kind: Kind; entity: number; provenance: 'construction' | 'inferred' } & (
  | { event: 'preserved' | 'modified'; from: number }
  | { event: 'merged'; from: number[] }
  | { event: 'copied'; from: number; instance: number[] }
  | { event: 'generated'; role?: Role; sources: { kind: Kind; entity: number }[] }
  | { event: 'unresolved'; candidates: number[]; reason: string });
```

For creation operations the profile and path wires are `inputs`, so `sources`
can name profile edges and vertices.

### 3.2 Invariants for every operation

Each is checkable by a generic function over (inputs, result, record).

| ID | Invariant |
| --- | --- |
| C1 | **Same body.** `results[i]` domains equal the F/E/V sets of the returned solids after all post-processing (unify, heal). The geometry is byte-identical to the call without a record, or no such call exists |
| C2 | **Result totality.** Every result entity has exactly one event |
| C3 | **Source accounting.** Every `from`/`sources` handle is in an `inputs` domain of the stated kind; `deleted` ⊆ inputs and disjoint from every `from` |
| C4 | **Kind.** `preserved`, `modified`, `merged`, `copied` never cross kinds |
| C5 | **Provenance.** No geometric matching behind a `construction` label |
| C6 | **Determinism.** Same serialized inputs and arguments give the same record up to a handle bijection, including after `serializeSolids` restore |
| C7 | **Atomicity.** A refusal returns no solid and no record |
| C8 | **No positional meaning.** Array order carries nothing; everything a consumer needs is in `from`, `sources`, `role` or `instance` |
| C9 | **Generated sources suffice.** Edge: the two faces (input domain) whose intersection or adjacency produced it. Vertex: the entities whose interference produced it. Face: per-class rule below |
| C10 | **Preserved means equal.** A `preserved` entity has geometry identical to its source |
| C11 | **Unresolved budget.** On the qualified class of each operation (below) there are zero `unresolved` events |

OpenZCAD's `validateEvolutionRecord` (new
`packages/kernel-adapter/src/evolution-record.ts`) enforces C1–C4 against its
own measured body and C10 by witness equality. A structural failure (C1–C4)
rejects the whole record: every result entity becomes `unresolved` and the
generic fillers run. A C10 failure demotes that one event to `unresolved`. An
`inferred` identity event is accepted only if the witness carrier is equal and
unique; otherwise it is demoted.

### 3.3 Invariants per operation class

Frozen role vocabulary in parentheses. "Qualified" defines C11's domain.

**Boolean** (fuse, cut, intersect, `fuseAll`, regions). Qualified: operands
whose faces are planes, cylinders, cones, spheres or tori.

- B1. Faces are only `modified` or `merged`. A boolean generates no face.
- B2. Edges are `preserved`, `modified`, or `generated` (`section`) with
  exactly two source faces from two different operands.
- B3. Vertices are `preserved` or `generated` (`section`) with the
  interfering entities as sources. This closes "not yet recorded" (§2.3).
- B4. Coplanar or same-surface unification on the shipped body is reported as
  `merged` on faces and on the edges it joins.
- B5. Identical, contained and disjoint operands still return a total record.
- B6. Operand order appears only in `inputs`; swapping operands of a fuse
  yields the same events up to handle bijection.

**Blend** (fillet, chamfer, both chamfer forms, variable radius, resize,
remove). Qualified: edges between analytic faces.

- BL1. Band faces are `generated` (`band`) with sources = the rounded edge and
  both support faces; corner patches (`corner`) with the vertex and its bands'
  edges.
- BL2. Support faces are `modified`.
- BL3. Every result edge and vertex has an event. Trim lines are `generated`
  (`trim`) from band and support; rounded edges are in `deleted`.
- BL4. Resize keeps the band as `modified` from itself. Remove puts the band
  in `deleted` and reports the restored edge as `generated` (`restored`) from
  the two supports.
- BL5. A partial result returns a record valid for the body actually produced,
  plus `failedEdges`.

**Sweep and loft** (extrude, revolve at any angle, sweep, helical sweep,
loft). Qualified: planar profiles of lines and arcs; straight, circular or
helical paths.

- S1. Faces: `cap.start`, `cap.end` (source: profile face); `side` (sources:
  one profile edge, plus the path edge when the path has several, plus the
  next section's edge for loft).
- S2. Edges: `cap-edge.start|end` (profile edge), `lateral` (profile vertex),
  `seam` (profile edge).
- S3. Vertices: `cap-vertex.start|end` (profile vertex).
- S4. Every role instance is unique given its sources, or the tie is declared
  `unresolved`. The kernel never numbers sides.

OpenZCAD maps profile handles to sketch entity ids when it builds the wire, so
`sweep.face.side.<objectId>.<index>` becomes `X:side(<sketch segment id>)`.

**Pattern, mirror, transform.**

- P1. Rigid and uniform-scale transforms: a bijection of `preserved`
  (rigid) or `modified` (scale) events.
- P2. Patterns and mirror: the original is `preserved`; each copy entity is
  `copied` with `instance` = the grid index (mirror: `[0]`). Per instance the
  source→copy map is a bijection on F/E/V.
- P3. A fused pattern reports the composition, with B1–B4 applying to the
  fuse.

**Direct edit and body modifiers** (move/offset/replace face, resize
cylindrical face, delete face, defeature, draft, shell, thicken, solid offset,
split, hole, thread, gear). Qualified: planar and coaxial-cylinder edits that
keep the adjacency graph; shell, offset and thicken of analytic bodies.

- D1. Untouched entities are `preserved`; moved faces and their re-trimmed
  neighbours are `modified`.
- D2. An edit that changes adjacency either returns a total record or refuses
  (C7). It never returns faces only.
- D3. Shell, offset, thicken: new faces are `generated` (`offset`) from the
  face they parallel; rim faces (`rim`) from the opening's boundary edge.
- D4. Split: each result solid has its own `results` entry; cut faces are
  `generated` (`section`) from the tool face and the cut solid.
- D5. Hole, thread, gear: every tool-made face carries a role (`bore`,
  `counterbore`, `floor`, `thread.*`, `gear.*`) with the target face as
  source.

**Import.**

- I1. STEP and mesh import return an empty-`inputs` record in which every
  entity is `generated` (`import`) with no sources. OpenZCAD names STEP
  entities `X:import(<kind>, <witness hash hex>)`, as today; twins are
  disambiguated by tier `n:` only and otherwise stay a tied class.
- I2. The reader is deterministic: the same bytes give the same witnesses to
  the quantum on every Remus version (pinned by a golden file).
- I3. Mesh entities are never referenceable; pickers refuse at pick time.

### 3.4 What leaves the contract

`resolveOperationOutput` index order, `journalSummary` censuses, the legacy
boolean map, `FaceEvolutionPayloadV1` and the probe on copies are retired on
the OpenZCAD side once their class has a V2 record. The journal remains a
Remus internal.

## 4. Migration and schema

### 4.1 One walker

New `packages/shared/src/topology-reference-walk.ts` exports
`forEachTopologyReference(document, visit)` and the arity table. It visits
every holder in the pack's §1.3 table with `{ holderPath, featureId, bodyId,
arity, reference, hashField }`. It replaces the hand list in
`persistedReferenceNamesProducer` (which omits `toFace`, drawings and reference
images) and is the only enumeration used by ingress validation, probe
decisions, upgrade, repair and unit conversion. A test asserts that every
schema type with a `*TopologyReference*` field is reachable.

### 4.2 Schema change

Bump `PROJECT_DOCUMENT_SCHEMA_VERSION` to the next unclaimed number (55 at the
time of writing; check open PRs first, per the repository rule).

- Additive: every `*Reference` field accepts `V5 | V6`. `EdgeVertexPointSource`
  gains optional `vertexReference`; `edgeReference` + `end` stay readable.
- `normalizeDocument` writes no names (it has no kernel). It does one thing:
  for a holder with a reference, set the sibling hash field to
  `topologyHashOfWitness(reference.witness)`. This removes the incident-10
  state from every stored document.
- Ingress validation (via the walker) checks grammar and witness canonical
  form for every holder. A malformed reference is kept and reported as
  `invalid` at build time, as now, but uniformly.

### 4.3 Backward compatibility

| Stored form | Read path | Upgrade |
| --- | --- | --- |
| Legacy hash-only | Existing `legacy-hash` rung | Existing runtime repair, now emitting v6 |
| v5 name + hash + witness | Existing `resolveTopologyReference` against v5 names published as aliases | To v6 on the first fully clean replay |
| v6 | `resolveReference` | — |

Upgrade mechanism (extends `topologyReferenceRepairCommand`; one command, no
undo entry, only after a fully clean replay, all-or-nothing per feature):

1. During the shadow period (§6 O5–O7) the legacy publishers still run and
   their v5 identities are attached to graph entities as aliases of the form
   `v5:<producingFeatureId>:<lineageName>`. A v5 reference that binds is
   rewritten to the entity's primary v6 name with a fresh witness.
2. After a legacy publisher is deleted, a v5 reference upgrades through
   **exact witness-key equality plus uniqueness** on the first replay of the
   unmodified document. This is the existing `hash-fallback` rung, permitted
   here because an unedited document reproduces its saved geometry. If it does
   not bind uniquely, the reference stays v5 and reports `untracked` with
   Re-pick.
3. `EdgeVertexPointSource` upgrades by resolving `edgeReference` + `end` under
   the old rule once, then storing the vertex's v6 name.

Assumption: clients older than the bump refuse newer documents (§7 A5). No
down-conversion is provided.

### 4.4 Removing demand dependence

Interim (before Remus B-class records): the boolean probe runs for a boolean
iff the walker finds any persisted reference whose `bodyId` descends from that
boolean's result. That is a function of the document alone, so reload cannot
change resolution (§1.6 item 1). UI demand may still add probes for unsaved
picks. End state: the probe, `lineageDemand.ts` and
`exact-idle-lineage-view.ts` are deleted, because the record arrives with the
geometry.

### 4.5 Code retired at the end

`OPERATION_CAPABILITIES` and `topologyLineageCapability` (replaced by the
coverage ledger, T11); `verifyTopologyEvolution`'s per-operation gates;
`decodeVerifiedRemusEvolution` (already dead); the per-feature builders in
`exact-lineage-builders.ts`, `exact-operation-lineage.ts` and
`remus-lineage.ts`, except the order functions; the web ladder; the geometric
rebinds of incidents 6 and 7. A new ADR-016 supersedes the affected parts of
ADR-013 and ADR-014.

## 5. Test plan

No new dependency: generators use a seeded PRNG loop as the existing 2,000-step
sweeps do. Parity files are `*.spec.ts` under `test/parity/`. Each test below
names what would falsify the design.

### 5.1 Pure properties (`packages/kernel-adapter/src/*.test.ts`, synthetic)

| ID | Property | Falsifies |
| --- | --- | --- |
| T1 | `parse(encode(n)) = n`; encoding is canonical under argument permutation; names over 1,024 bytes digest deterministically and stay equal under re-encoding | Name grammar |
| T2 | For 5,000 random valid records: every result entity has ≥ 1 name or is counted in `gaps`; two entities share a name only inside a declared `t:` class | Totality of §2.4 |
| T3 | Renumbering all handles by a random bijection and shuffling `events` yields a graph with the same (witness → names) multiset | Positional leakage (C8) |
| T4 | In `strict`, replacing `ref.witness` with any other canonical witness never changes the result | "Witness is not identity" |
| T5 | `resolveReference` returns exactly one status; a `bound` entity's name is equal to, a descendant of, or an ancestor of `ref.name` | Silent rebinding |
| T6 | Split then identity: a reference to `S` after an n-way split gives n pieces (`set`), `split` (`single`), one carrier (`carrier`, equal planes). A piece reference when the split is removed gives `bound`/`widened`. A piece reference when discriminators change gives `split`, never another piece | §2.5 steps 3–5 |
| T7 | Merge: a reference to either source of a `merged` entity binds it; a later split of that entity keeps both alias chains | Merge rule |
| T8 | 16 injected record faults (omitted entity, phantom entity, duplicate event, cross-kind identity, `from` outside inputs, `deleted` ∩ `from`, …) each reject the record; no name is published from a rejected record except through the two fillers | Trust boundary of §3.2 |

### 5.2 Real-kernel properties (`test/*.test.ts`)

**T9 Golden references** (`test/parity/golden-references.spec.ts`, fixtures in
`test/parity/golden-references/`). Each fixture is a saved document with stored
references plus a pinned table `holderPath → status, note, witness hash`.
Replay must reproduce the table exactly. Fixtures: one per family below, plus
one v5 and one legacy hash-only variant of each. A changed table needs an
explicit re-bless and, if a name changed, a `COMPAT_ALIAS_RULES` entry. Falsifies
cross-version stability.

**T10 Document purity** (`test/reference-purity.test.ts`). For each family,
the published name set and every resolution result are byte-identical across:
cold adapter; warm cache; idle and eager demand; after a random sequence of 20
previews and exports; handles shifted by 4,000; JSON round trip on a fresh
adapter. Falsifies diagnosis item 4.

**T11 Coverage ledger** (`test/lineage-coverage.test.ts`,
`test/lineage-coverage-ledger.json`). For each (operation class, entity kind)
over the family corpus, record counts of construction-named, filler-named,
tied and unnamed entities. The test fails if unnamed or filler counts rise, or
if an operation in the adapter's operation enum has no row. Falsifies "no
silent gaps".

**T12 No silent retarget.** `test/reference-oracle.test.ts`. Each family
defines a closed-form label function `label(entity, params)` (for example "the
planar face with outward normal +x at x = width"), written without reference
to names. Author references at `p0`; for 200 seeded parameter vectors replay
and assert, per reference: `bound` to exactly the entities with the authored
label, or a non-`bound` typed status. Any `bound` to a differently labelled
entity fails. This is the test that proves the design wrong.

**T13 Survival floor.** Same file. Fail-closed everywhere would pass T12, so
each family lists references that **must** bind over a stated range.

| Family | Model | Adversarial edit | Must hold |
| --- | --- | --- | --- |
| F1 | Bracket: two boxes, union, inside-corner fillet, two holes | `width` 80→120; swap `targetBodyIds` order | Fillet and holes bind; identical names after the swap |
| F2 | Plate with two equal-height bosses, sketch on left cap | Plate resize; boss heights made unequal then equal | Sketch stays on the left cap |
| F3 | Plate, sketch and offset-face on top, slot that becomes through-all | Slot depth across the through threshold, both directions | Sketch (`carrier`) binds throughout, origin continuous within 1e-3; offset-face (`single`) gives `split` when through, binds again when not |
| F4 | Hexagon extrude, fillet on one side edge, sketch on one side face | Insert a vertex into the polygon before that side | Both bind to the same labelled side (needs A3) |
| F5 | Grid pattern 3×3, datum on cell 2-1 vertex | Count 3→5→2 | Binds for 3 and 5; `deleted` naming the pattern at 2 |
| F6 | Box, datum point on a vertex | Rotate the box 180° about z upstream | Same labelled corner (the `end: 0\|1` failure) |
| F7 | Pipe with cross hole, fillet on both hole rims | Hole diameter change | `set` binds both loops; a `single` pick of one loop is `t:2` → `split` at pick time, not after |
| F8 | Sphere with fused cylinder boss, seam fillet | Boss radius change | Binds (parity with incident 4) |
| F9 | Cylinder unioned so its rim is four arcs, fillet on the rim | Upstream move that makes the rim one closed edge | Binds as `pieces: 4`, then `widened` |
| F10 | Box, fillet, second fillet on a trim line, History edit adding an edge | Radius edits | Second fillet binds; summary reads `resolvedInputs` |
| F11 | Sketch segment deleted and redrawn at the same place | — | `not-produced`; never rebinds |
| F12 | Ten chained booleans | — | Longest name ≤ 1,024 bytes; all references bind |
| F13 | Two bosses symmetric about a plane, swapped by a parameter | Swap | Records which tier named the seam pieces; see A6 |

**T14 Migration** (`test/reference-upgrade.test.ts`). Take every document
builder used by the existing lineage tests in §5 of the pack, save at schema
54, load at the new version, replay, upgrade, save, reload on a fresh adapter.
Assert: every reference that bound before binds to an entity with an equal
witness key; none that failed now binds; the second replay performs no
upgrade; hash fields equal derived hashes.

**T15 Policy allowlist** (`test/reference-policy.test.ts`). The only modules
that pass `policy: 'display'` are a literal allowlist (hover label, transient
measurement readout, selection-highlight restore). Any other call site fails.

### 5.3 Remus conformance (`crates/operations/tests/evolution_conformance.rs`)

One generic checker `assert_conforms(inputs, result, record)` for C1–C10, run
over every exported operation × a shared corpus, with a checked-in budget file
for C11 (`evolution_budget.json`, counts of `unresolved` per operation and
kind; the test fails on any increase). C6 runs each case twice and once after
a serialize/restore, comparing up to handle bijection. A second WASM-level
suite (`crates/wasm/src/bindings/evolution_conformance_tests.rs`) checks C1 by
comparing serialized bytes with the non-record call.

### 5.4 CI placement

Add to `test/unit-ci-files.json`: the pure suites (T1–T8), T10 for F1 and F5,
T12/T13 for F1, F3 and F6, and T15. T9 runs in `pnpm test:parity-corpus`. One
Playwright case for the re-pick flow carries `@ci-smoke`.

## 6. Sequenced PRs

Each step is independently shippable and leaves `main` green. Every OpenZCAD
step adds a fragment under `docs/roadmap-evidence/` for the row named. Remus
steps (R) and OpenZCAD steps (O) interleave; dependencies are stated.

### Phase 0: gates before change

**O1. Golden references and CI pins** (K05). Add T9 with v5 and legacy
fixtures for F1, F2, F5, F8 generated at the current `main`; add
`boolean-evolution-lineage.test.ts` and `pattern-instance-lineage.test.ts` to
the smoke manifest. *Accept:* parity job replays the fixtures; no production
code changed.

**O2. Reference walker and ingress validation** (K05). Add
`topology-reference-walk.ts`; add `isCanonicalFaceTopologyReference`; route
`document-validation.ts`, `reference-images.ts` and
`persistedReferenceNamesProducer` through the walker; normalise hash fields
(§4.2) without a schema bump (the value is derived). *Accept:* reachability
test passes; a new `test/boolean-evolution-toface.test.ts` shows a `toFace`
reference to a probe-only face resolves identically before and after reload
with empty UI demand; a fixture with a mismatched hash/reference pair
(incident 10) replays by the reference.

**O3. Document-pure probe decision** (H02). Implement §4.4's interim rule in
`exact-boolean-evolution.ts`. *Accept:* T10 for F1 and F2 passes;
`h02-lineage-mode-qualification.test.ts` unchanged and green.

**R1. `EvolutionRecordV2` type, encoder, decoder.** In
`crates/wasm/src/types.rs` and `bindings/evolution.rs`; document it in
`docs/design/evolution-contracts.md`. Re-encode the existing result-aware
payloads of `offsetJournaled`, `extrudeJournaled`, `revolveJournaled` as V2
beside the old field. *Accept:* decoder rejects the T8 fault list; old fields
byte-identical.

**R2. Conformance harness and emitter audit.** Add §5.3 with the budget file
seeded from current behaviour. Add a debug-only counter incremented wherever a
splitter emits an edge with `source_topo_edge: None` and no section origin,
asserted zero on the qualified boolean corpus. *Accept:* harness green at the
seeded budget; the counter reproduces incidents 5 and 11 when their fixes are
reverted locally.

### Phase 1: the algebra, in shadow

**O4. Pure modules.** `entity-name.ts`, `evolution-record.ts`,
`lineage-graph.ts`, `reference-resolution.ts` with T1–T8. No production
import. *Accept:* suites green and in smoke.

**O5. Choke point and record adapters.** Add
`packages/kernel-adapter/src/remus-evolution-records.ts`, converting each
payload OpenZCAD already receives (entity-evolution JSON,
`FaceEvolutionPayloadV1`, move-face `faceEvolution`, pattern blocks, semantic
builder outputs) into an `EvolutionRecordV2`, with `unresolved` for everything
not claimed. Add `commitOperation(inputs, result, featureId, record)` in
`exact-types.ts` as the only constructor of an `ExactShape` with lineage; an
operation with no kernel evidence passes an all-`unresolved` record. Build the
graph beside `RemusLineageState`; publish nothing from it. *Accept:* a test
proves no `ExactShape` is created outside `commitOperation`; shadow comparator
(`test/lineage-shadow.test.ts`) shows that over the existing lineage tests'
documents every entity with a v5 name has exactly one primary v6 name and the
v5→v6 map is injective; T11 ledger is created; rebuild time on the H02
scenarios regresses < 5%.

**O6. Sketch-keyed sweep roles** (S04). `X:side(<segment id>)`,
`X:lateral(<point id>)` in the record adapter for extrude and revolve, using
the stable sketch segment ids (A3). *Accept:* F4 passes T12/T13 in shadow.

### Phase 2: schema and switch

**O7. Schema bump: v6 types, read path, vertex references** (K05). §4.2.
Resolver dispatch by `refVersion`; consumers call `resolveReference` with
their arity from the table; v5 aliases published into the graph. Writes still
v5 behind a constant. *Accept:* T14 load half passes; all existing lineage
suites green unchanged.

**O8. Arity semantics in consumers.** `exact-reference-resolution.ts` (fillet,
chamfer, shell, draft take all pieces); `face-attachment.ts` (carrier with
area-weighted anchor); `resolveEdgeVertex` accepts a vertex reference.
*Accept:* F3, F7, F9 pass T13; `face-attachment.test.ts` sweeps still cap
single-step rotation at 0.5°.

**O9. Write v6 and upgrade.** Flip the constant; extend
`topologyReferenceRepairCommand` per §4.3; pickers store v6. *Accept:* T14
fully passes; `parameter-lineage-repair.spec.ts` passes with v6 assertions;
T12/T13 pass for F1, F2, F5, F6, F8, F10, F11, F12.

**O10. Typed statuses and tombstones.** Replace `mappedFailureReason` and the
regexes in `staleDirectEditFaceRepair` with the §2.5 statuses carried on
`TopologyLineageDiagnostic`; messages per §2.6. *Accept:* every status has a
unit test producing it from a real-kernel document; changing a message string
breaks no test other than its own snapshot.

**O11. Uniform re-pick** (U06). Generalise the datum flow to fillet, chamfer,
hole, face sketch, direct edit, drawing annotation, with the piece chooser and
witness ghost. *Accept:* one `@ci-smoke` Playwright case repairs a `deleted`
fillet edge and a `split` offset-face in F3; each is one undo step.

**O12. One resolver in the web app.** `topologyResolution.ts` becomes a
wrapper over `resolveReference`; drawing annotations and datum-vertex repair
move to `strict`; T15 added. *Accept:* `topology-resolution.test.ts` rewritten
to the two policies; no `topologyId` match across builds.

**O13. Selection by name.** Worker frames and undo snapshots carry primary
names; selection restore resolves by name; History summaries read
`resolvedInputs`. Delete the geometric rebinds of incidents 6 and 7 and the
witness-reading summary of incident 1. *Accept:*
`through-hole-chamfer-resize.spec.ts` and `featureSummary.test.ts` pass
without the removed code.

### Phase 3: kernel records, class by class

Each R step ships a V2 record for one class and tightens its budget to zero on
the qualified class. Each paired O step, after the `update-remus` PR lands,
switches that class's adapter to the kernel record, deletes its legacy
publisher, adds a `COMPAT_ALIAS_RULES` entry where names changed, and re-blesses
T9. *Accept for every pair:* T9–T14 green; the class's ledger row shows zero
filler-named entities on the qualified class.

| Step | Remus | OpenZCAD follow-up |
| --- | --- | --- |
| R3 / O14 | Boolean `*Detailed` and `fuseAll` return V2 (B1–B6), including unification as `merged` and vertex sources | Delete the probe, `lineageDemand.ts`, `exact-idle-lineage-view.ts`, `reconcileRemusBooleanLineage`, the carrier rule |
| R4 / O15 | Fillet, chamfer, variable fillet, resize, remove return V2 with edges and vertices (BL1–BL5) | Delete `createRemusModifierEvolutionLineage`, `supportIdentity`; M03 per-vertex controls unblocked |
| R5 / O16 | Linear, circular, grid pattern, mirror, transform return V2 with `copied` (P1–P3) | Delete every `resolveOperationOutput` and `journalSummary` read; use `circularPattern` records |
| R6 / O17 | Extrude, revolve (any angle), sweep, helical, loft return V2 with roles (S1–S4) | Delete `exact-lineage-builders.ts` sweep naming; partial revolve and drafted extrude leave hash-only |
| R7 / O18 | Shell, split, thicken, offset face/solid, push-pull, draft, move/replace/delete face, defeature return V2 (D1–D4) | Delete `exact-operation-lineage.ts` helpers; section cut edges (D03) gain names |
| R8 / O19 | Hole, thread, gear roles (D5); import record and reader determinism (I1–I2) | Delete `holeLineage`; golden STEP fixture |

Order rationale: boolean edges and blends account for 8 of the 20 incidents;
patterns remove the only positional kernel read; sweeps and modifiers clear
the hash-only islands of §3. This deliberately reorders Remus's stated plan
(shell, split, then sweeps).

**O20. Retire.** Delete what §4.5 lists and still remains; write ADR-016;
correct ADR-013/014 pointers. *Accept:* no import of the deleted symbols; T14
still passes through path 2 of §4.3 for every golden v5 fixture.

## 7. Assumptions and experiments

| ID | Assumption | Experiment | If false |
| --- | --- | --- | --- |
| A1 | Remus can attach a record to the `*Detailed` boolean with byte-identical geometry (the divergence was measured at an older pin only) | At `087d6360`, run `*WithEntityEvolution` and `*Detailed` over the parity corpus and compare `serializeSolids` bytes | R3 unifies the two code paths first; O3's document-pure probe stays meanwhile |
| A2 | Unification can be reported as `merged` on the shipped body | Compare a journaled boolean + `runHealPipelineJournaled(["unify_same_domain"])` with the shipped union, bytes and face count | R3 adds merge recording to `unify_faces` directly |
| A3 | Sketch polyline and polygon segments have ids that survive vertex insertion (S04) | Insert a vertex in a persisted polygon; diff segment ids | O6 depends on an S04 PR that adds them; until then index-keyed sides are published and F4 stays an expected failure |
| A4 | A same-call record costs < 15% of boolean time (the probe costs 2.03×) | Benchmark R3 on the H02 scenarios | Keep records on by default only for bodies with persisted references (O3's rule) |
| A5 | Older clients refuse documents with a newer schema version | Open a bumped document in the previous release | Add a load-time guard before O7 |
| A6 | Tiers `g:` and `n:` separate almost all splits; `o:` is rare and `t:` rarer | Over the K10 combination matrix, count split groups per tier (F13 logs it) | If `o:` exceeds 5% of groups referenced by `single` consumers, add kernel-provided order keys to the record; an order swap at constant `n` is the one known silent-retarget path and T12 on F13 measures it |
| A7 | STEP import yields quantum-stable witnesses across Remus versions | Golden STEP fixture in T9 across two pins | Imported names need a file-carried id; design separately |
| A8 | Trusting construction claims without witness re-verification does not mis-bind | T12 across all families after each O14–O19 switch; R2's C5/C10 checks | Keep witness verification for that class and treat the kernel claim as evidence, as today |
