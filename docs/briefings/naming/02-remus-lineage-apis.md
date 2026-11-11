# 2. Remus lineage and evolution APIs

This section lists every Remus API that reports how faces, edges or vertices
evolve, at the commit OpenZCAD pins:
`087d6360e6299f357f9b662fe6ebe42ffc1a9aab`
([package.json](../../../packages/kernel-adapter/package.json)). Sources are the
Rust crates, WASM bindings, committed `remus_wasm.d.ts`, and the design notes
[`evolution-contracts.md`](https://github.com/esaueng/remus/blob/087d6360e6299f357f9b662fe6ebe42ffc1a9aab/docs/design/evolution-contracts.md),
[`wasm-face-evolution.md`](https://github.com/esaueng/remus/blob/087d6360e6299f357f9b662fe6ebe42ffc1a9aab/docs/wasm-face-evolution.md),
[`evolution-audit.md`](https://github.com/esaueng/remus/blob/087d6360e6299f357f9b662fe6ebe42ffc1a9aab/docs/kernel-maturity/evolution-audit.md)
and
[RFC 0003](https://github.com/esaueng/remus/blob/087d6360e6299f357f9b662fe6ebe42ffc1a9aab/docs/design/rfc-0003-persistent-naming.md).
A guarantee is labelled **stated** when a doc comment, design note or named
test says it. It is marked *(inferred)* when I derived it from the code.

The kernel exposes lineage in three layers:

1. **In-band payloads.** One call returns the result and a one-operation
   map keyed by session-local handles. Nothing is recorded.
2. **The evolution journal.** `*Journaled` calls append an entry to a
   per-session log and return its `op`. `PersistentRef`s resolve by chasing
   those entries.
3. **Attribute propagation.** Face names and colours are copied forward over
   journal entries or maps.

## 2.0 Summary

| API (JS) | Operation(s) | Output | Key guarantee | Consumed by OpenZCAD? |
|---|---|---|---|---|
| `fuseWithEvolution`, `cutWithEvolution`, `intersectWithEvolution` | Boolean | JSON string `{solid, evolution:{modified, generated, deleted, unresolved, origin}}` | Faces only. `origin` tells construction (GFA) from geometric fallback | No |
| `fuseWithEntityEvolution`, `cutWithEntityEvolution`, `intersectWithEntityEvolution` | Exact GFA boolean | JSON `{solid, evolution:{faces[], edges[], vertices[]}}` | Edges and vertices total over the result. No deleted bucket. Nothing journaled | Yes, as a probe on operand copies |
| `filletWithEvolution`, `chamferWithEvolution`, `chamferDistanceAngleWithEvolution`, `resizeBlendWithEvolution`, plus `decodeEvolutionPayload` | Fillet, chamfer, blend resize | `FaceEvolutionPayloadV1` object | Complete source and result domains. Never inferred: an engine without history gives `provenance:"unavailable"` | First four yes. Decoder no |
| `moveFacesJournaledWithQuality` (`faceEvolution` field) | Face move | Legacy face map plus `op` | Face map with an origin label | Yes |
| `offsetJournaled`, `extrudeJournaled`, `revolveJournaled` | Offset, extrude, full-turn revolve | `{solid, op, evolution}` with a completeness report | Every result F/E/V entity is attributed or typed unresolved, checked against the result | No |
| Other `*Journaled` calls plus `imprint` (23 entry points, §2.6) | Booleans, blends, patterns, moves, edits, heal | `{solid\|compound, op}` | Coverage differs by family. Only the journal can be queried | Some (§2.9) |
| `journalSummary` | All entries | JSON array of `{op, kind, type, detail}` | Counts only | Yes |
| `journalBarrier` | Any unrecorded operation | `op` | Cuts every reference that passes through the solid | No |
| `resolveOperationOutput` | Any evolution entry | Resolution JSON | Fails closed, with eight typed statuses | Yes |
| `makeOperationOutputRef`, `addRefDiscriminator`, `captureSignatureRef`, `resolveRef`, `resolveRefFaceAttributes` | Persistent references | Versioned JSON reference and resolution JSON | Value object. Codec v1 is "read forever" | No |
| `propagateAttributesForOp`, `setFaceName`, `getFaceName` | Attribute carry-forward | Report JSON | Copies only through identity claims. Inferred entries need an explicit opt-in | No |

The naming and evolution calls also have `executeBatch` companions
([evolution.rs L900](https://github.com/esaueng/remus/blob/087d6360e6299f357f9b662fe6ebe42ffc1a9aab/crates/wasm/src/bindings/evolution.rs#L900)),
which OpenZCAD does not use.

## 2.1 Shared Rust vocabulary: `EvolutionMap` and `EvolutionOrigin`

Most face-level payloads are encodings of
[`remus_operations::evolution::EvolutionMap`](https://github.com/esaueng/remus/blob/087d6360e6299f357f9b662fe6ebe42ffc1a9aab/crates/operations/src/evolution.rs#L77):

```rust
pub struct EvolutionMap {
    pub modified: HashMap<usize, Vec<usize>>,   // input -> outputs (identity)
    pub generated: HashMap<usize, Vec<usize>>,  // input -> new outputs (adjacency)
    pub deleted: HashSet<usize>,
    pub unresolved: BTreeMap<usize, Vec<usize>>, // output -> candidate inputs
    pub origin: EvolutionOrigin,                // Construction | Geometry
}
```

The doc comments state that `modified` is an identity claim and `generated`
an adjacency claim; a blend band names both faces it separated
([L92-103](https://github.com/esaueng/remus/blob/087d6360e6299f357f9b662fe6ebe42ffc1a9aab/crates/operations/src/evolution.rs#L92)).
An input in no bucket is *unknown*, neither surviving nor deleted.
`Construction` is the operation's own record; `Geometry` is a
normal-plus-centroid inference "that can be wrong even when it reports no
ambiguity" ([L40-56](https://github.com/esaueng/remus/blob/087d6360e6299f357f9b662fe6ebe42ffc1a9aab/crates/operations/src/evolution.rs#L40)).
The type does not enforce completeness: `is_complete()` only checks that
`unresolved` is empty, so an empty map passes, and callers must use
`accounts_for_result`
([L168-189](https://github.com/esaueng/remus/blob/087d6360e6299f357f9b662fe6ebe42ffc1a9aab/crates/operations/src/evolution.rs#L168)).
`to_json` sorts keys for determinism
([L291-295](https://github.com/esaueng/remus/blob/087d6360e6299f357f9b662fe6ebe42ffc1a9aab/crates/operations/src/evolution.rs#L291));
arrays keep insertion order *(inferred)*.

The keys and values are face arena indices, which are the same numbers as the
public handles
([wasm-face-evolution.md L26-28](https://github.com/esaueng/remus/blob/087d6360e6299f357f9b662fe6ebe42ffc1a9aab/docs/wasm-face-evolution.md#L26)).
Handles last only for the session. Deserialization allocates fresh handles
(evolution-contracts
[§8, §9.5](https://github.com/esaueng/remus/blob/087d6360e6299f357f9b662fe6ebe42ffc1a9aab/docs/design/evolution-contracts.md#L205)).

## 2.2 Legacy boolean face map: `*WithEvolution`

- **Binding:** `fuseWithEvolution(a, b): any`, plus `cut` and `intersect`
  ([booleans.rs L602-678](https://github.com/esaueng/remus/blob/087d6360e6299f357f9b662fe6ebe42ffc1a9aab/crates/wasm/src/bindings/booleans.rs#L602)).
  The return value is a JSON *string*, typed `any`.
- **Producer:**
  [`boolean_with_evolution`](https://github.com/esaueng/remus/blob/087d6360e6299f357f9b662fe6ebe42ffc1a9aab/crates/operations/src/boolean/mod.rs#L2346).
- **How it is populated:** When the operands are not identical or contained,
  it runs `boolean_with_face_origins` from the GFA, applies only heals that
  keep face ids, and gates the result. On success every sourced output is
  `modified`, every synthesised face is `unresolved` with no candidates, and
  every input that is not sourced is added to `deleted` by set difference
  ([L2447-2466](https://github.com/esaueng/remus/blob/087d6360e6299f357f9b662fe6ebe42ffc1a9aab/crates/operations/src/boolean/mod.rs#L2447)).
  In every other case it falls back to the normal-plus-centroid matcher,
  labelled `origin:"geometry"` (L2471-2487).
- **Stated caveat:** `unify_faces` "is intentionally NOT run" on the faithful
  path, because merging coplanar faces would discard provenance (L2433-2435).
  The map therefore describes a body that has not been unified.
- **Guarantees:** Faces only. This path writes nothing to the journal.
  evolution-contracts notes "boolean/mod.rs contains no journal calls"
  ([§8](https://github.com/esaueng/remus/blob/087d6360e6299f357f9b662fe6ebe42ffc1a9aab/docs/design/evolution-contracts.md#L212)).
- **OpenZCAD:** Not called. The adapter has a strict decoder for this payload
  shape, `decodeVerifiedRemusEvolution`
  ([remus-lineage.ts](../../../packages/kernel-adapter/src/remus-lineage.ts)),
  but nothing in `src` calls it.

## 2.3 Boolean entity evolution: `*WithEntityEvolution` (Issue 12)

- **Binding:** `fuseWithEntityEvolution(a, b): string`, plus `cut` and
  `intersect`
  ([evolution.rs L1184-1212](https://github.com/esaueng/remus/blob/087d6360e6299f357f9b662fe6ebe42ffc1a9aab/crates/wasm/src/bindings/evolution.rs#L1184)).
- **Encoder:** `entity_evolution_json`
  ([L25-76](https://github.com/esaueng/remus/blob/087d6360e6299f357f9b662fe6ebe42ffc1a9aab/crates/wasm/src/bindings/evolution.rs#L25)).
- **Producer:**
  [`remus_algo::gfa::boolean_with_entity_evolution`](https://github.com/esaueng/remus/blob/087d6360e6299f357f9b662fe6ebe42ffc1a9aab/crates/algo/src/gfa.rs#L1155),
  wrapped by
  [`operations::boolean::boolean_with_entity_evolution`](https://github.com/esaueng/remus/blob/087d6360e6299f357f9b662fe6ebe42ffc1a9aab/crates/operations/src/boolean/mod.rs#L240).

```text
faces:    [{face, source: number|null}]
edges:    [{edge, event:"preserved"|"modified", from}
           | {edge, event:"generated", faceA, faceB}   // nullable
           | {edge, event:"unresolved"}]
vertices: [{vertex, event:"preserved", from} | {vertex, event:"created"}]
```

Stated guarantees:

- Lineage comes only from construction records: store copy maps, pave
  blocks, the face–face section-origin table and export maps. Any entity that
  no record reaches is `unresolved`, "never bound by geometric guessing".
- The edge and vertex lists are "Total over the result's edges/vertices"
  ([gfa.rs L888-939](https://github.com/esaueng/remus/blob/087d6360e6299f357f9b662fe6ebe42ffc1a9aab/crates/algo/src/gfa.rs#L888)).
- `created` vertices do not name the interference that generated them. The
  doc says this is "not yet recorded".
- The path is exact only, with no mesh fallback. It does not special-case
  identical operands. Results pass the same exact-result gate as the plain
  booleans, and every refusal rolls back.
- **Splits:** several result faces can share one `source`, and pave-block
  pieces share a `modified` parent.
- **Merges:** none are ever invented. Fuse keeps coplanar patches as separate
  faces (`adjacent_fuse_keeps_coplanar_patches_separate`, evolution-contracts
  [§3](https://github.com/esaueng/remus/blob/087d6360e6299f357f9b662fe6ebe42ffc1a9aab/docs/design/evolution-contracts.md#L77)).
- **Deletion:** there is no deleted bucket. "A consumed input is simply
  absent — unknown, never implicitly surviving". The test
  `entity_evolution_face_indices_are_live_in_the_result` pins that every
  reported face is live and every named source is an operand face
  ([§8](https://github.com/esaueng/remus/blob/087d6360e6299f357f9b662fe6ebe42ffc1a9aab/docs/design/evolution-contracts.md#L188)).
- The JSON encoding is called stable ("Event encodings are stable JSON",
  [evolution.rs L4-6](https://github.com/esaueng/remus/blob/087d6360e6299f357f9b662fe6ebe42ffc1a9aab/crates/wasm/src/bindings/evolution.rs#L4)).
  It has no version field.
- Nothing is journaled, so the next journaled operation records a
  `GlobalBarrier`.

**OpenZCAD** calls all three
([exact-boolean-evolution.ts](../../../packages/kernel-adapter/src/exact-boolean-evolution.ts)).
On an earlier pin (`4bbcd5c7`) it measured them as *a different boolean* from
the plain calls, so it runs them on operand copies only to read names, checks
the probe is the same body, and takes geometry from the typed detailed calls.
This was not re-measured at `087d6360`.
The decoder throws on any unknown event. Face `source` claims must pass a
witness check, edges are carried only on `preserved` with an equal witness,
and vertices are dropped
([remus-lineage.ts](../../../packages/kernel-adapter/src/remus-lineage.ts),
[topology-lineage.ts](../../../packages/kernel-adapter/src/topology-lineage.ts)).

The disconnected-region variants `booleanRegions` and
`booleanCompoundRegions` compute the same F/E/V lineage and refuse when any
edge lineage is incomplete
([boolean/mod.rs L318-330](https://github.com/esaueng/remus/blob/087d6360e6299f357f9b662fe6ebe42ffc1a9aab/crates/operations/src/boolean/mod.rs#L318)).
However, they return only a compound handle
([booleans.rs L98-136](https://github.com/esaueng/remus/blob/087d6360e6299f357f9b662fe6ebe42ffc1a9aab/crates/wasm/src/bindings/booleans.rs#L98)),
so the lineage is checked inside the kernel and never reaches JS.

## 2.4 `FaceEvolutionPayloadV1`: fillet, chamfer and blend resize

These calls return the payload:

- `filletWithEvolution(solid, edges, radius)`
- `chamferWithEvolution(solid, edges, d)`
- `chamferDistanceAngleWithEvolution(solid, edges, d, angle)`
- `resizeBlendWithEvolution(solid, face, expected, new)`

All four return `FaceEvolutionPayloadV1`
([operations.rs L551, L666, L938, L2624](https://github.com/esaueng/remus/blob/087d6360e6299f357f9b662fe6ebe42ffc1a9aab/crates/wasm/src/bindings/operations.rs#L551)).
The free function `decodeEvolutionPayload(json)` validates a payload that was
stored or transported.

```ts
interface FaceEvolutionPayloadV1 {
  schemaVersion: number;                       // always 1
  source: { solid: number; faces: number[] };  // complete input domain
  result: { solid: number; faces: number[] };  // complete final domain
  evolution: { provenance: 'construction' | 'unavailable';
    modified, generated: { source: number; results: number[] }[];
    deleted: number[]; unresolvedResults: { result; candidates }[];
    unresolvedSources: number[] };
}
```

The contract is stated in
[wasm-face-evolution.md L52-121](https://github.com/esaueng/remus/blob/087d6360e6299f357f9b662fe6ebe42ffc1a9aab/docs/wasm-face-evolution.md#L52)
and implemented in
[types.rs L362-470](https://github.com/esaueng/remus/blob/087d6360e6299f357f9b662fe6ebe42ffc1a9aab/crates/wasm/src/types.rs#L362):

- **Set equalities.** `modified sources ∪ deleted ∪ unresolvedSources =
  source.faces` and `modified ∪ generated ∪ unresolved results =
  result.faces`. The decoder rejects unknown versions or fields,
  duplicates, out-of-domain handles, overlapping claims, incomplete coverage,
  and claims labelled `unavailable`.
- **Completeness by construction.** `from_map` adds any result face that has
  no claim as an unresolved result with no candidates. Any source that is
  neither modified nor deleted becomes an unresolved source.
- **Never inferred.** A geometry map is never promoted. The WASM helper
  `wasm_blend_evolution` returns an empty geometry map when an engine has no
  construction origins, so the payload becomes `unavailable` with every
  handle unresolved
  ([operations.rs L157-169](https://github.com/esaueng/remus/blob/087d6360e6299f357f9b662fe6ebe42ffc1a9aab/crates/wasm/src/bindings/operations.rs#L157)).
- **`deleted`** lists only inputs the builder explicitly recorded as absent.
  Being absent from `modified` does not count as deletion.
- **Same geometry.** Same engine cascade and post-processing; smoke tests
  compare the ordinary and evolution solids byte for byte.
- **Blend bands** are listed under `generated` for *both* adjacent faces and
  never under `modified`.

**OpenZCAD** calls the four producers
([exact-edge-modifiers.ts](../../../packages/kernel-adapter/src/exact-edge-modifiers.ts),
[exact-direct-edit-ops.ts](../../../packages/kernel-adapter/src/exact-direct-edit-ops.ts)).
It accepts a payload only when all of these hold: `provenance ===
"construction"`, both unresolved sets are empty, and both domains equal its
own measured face sets (`evolutionPayloadMatches` in
[remus-lineage.ts](../../../packages/kernel-adapter/src/remus-lineage.ts)).
It does not call `decodeEvolutionPayload`. Variable-radius fillet has no
evolution entry point, as the adapter notes. The adapter's capability table
still marks chamfer lineage `hash-only`.

## 2.5 Result-aware F/E/V history: offset, extrude and revolve

- **Bindings:** `offsetJournaled(solid, d)`,
  `extrudeJournaled(face, dx, dy, dz, d)` and
  `revolveJournaled(face, origin…, axis…, angleDeg)`
  ([evolution.rs L1499-1571](https://github.com/esaueng/remus/blob/087d6360e6299f357f9b662fe6ebe42ffc1a9aab/crates/wasm/src/bindings/evolution.rs#L1499)).
  Each returns `{solid, op, evolution}`.
- **Encoder:** `entity_history_json`
  ([L78-200](https://github.com/esaueng/remus/blob/087d6360e6299f357f9b662fe6ebe42ffc1a9aab/crates/wasm/src/bindings/evolution.rs#L78)).

```text
evolution: { origin, deleted: [face],
  faces|edges|vertices: [{<kind>, event: "modified"(from) | "merged"(from[])
                          | "generated"(faces[]) | "unresolved"(candidates[], reason)}],
  completeness: { accounted, resolved,
                  faces|edges|vertices: {omitted[], phantom[], unresolved[]} } }
```

The unresolved `reason` is one of `ambiguous_incidence`,
`unmapped_incident_face` or `unresolved_face_origin`.

Boundary claims come from
[`boundary_evolution`](https://github.com/esaueng/remus/blob/087d6360e6299f357f9b662fe6ebe42ffc1a9aab/crates/operations/src/boundary_evolution.rs).
It maps each result edge's face-use multiset back through the exact face
claims and compares it with the source incidence. Exactly one match gives
`Modified`, none gives `Generated`, and several give `Unresolved`. "No
coordinate or tolerance is consulted". The producer "refuses, and rolls back,
any history that omits a result entity or claims one outside the result"
([evolution-audit.md L243-275](https://github.com/esaueng/remus/blob/087d6360e6299f357f9b662fe6ebe42ffc1a9aab/docs/kernel-maturity/evolution-audit.md#L243)).

Stated scope: offset leaves torus seams and sphere equators
`ambiguous_incidence` and matches plain offset bit for bit; extrude has zero
deleted or unresolved entities on qualified profiles; revolve covers only
full-turn, planar, hole-free, straight-edge radial profiles and otherwise
refuses atomically.

**OpenZCAD** calls none of the three. It uses `offsetSolidV2` (audit
L258-259) and builds extrude and revolve lineage semantically
([exact-lineage-builders.ts](../../../packages/kernel-adapter/src/exact-lineage-builders.ts)).

## 2.6 The evolution journal and the `*Journaled` family

In
[`topology/src/journal.rs`](https://github.com/esaueng/remus/blob/087d6360e6299f357f9b662fe6ebe42ffc1a9aab/crates/topology/src/journal.rs#L1),
each entry is an `Evolution {origin, scope, events}`, an explicit `Barrier`,
or a synthetic `GlobalBarrier`
([L333-361](https://github.com/esaueng/remus/blob/087d6360e6299f357f9b662fe6ebe42ffc1a9aab/crates/topology/src/journal.rs#L333)).

Events are recorded per subject, and duplicates are refused:

| Event | Subject is a | Meaning |
|---|---|---|
| `Preserved{from}` | Result entity | Carried through unchanged |
| `Modified{from}` | Result entity | A modified piece of `from` |
| `Generated{sources}` | Result entity | New entity built from `sources` |
| `Merged{from[]}` | Result entity | Merge of several inputs |
| `Deleted` | Input entity | The input was removed |
| `Unresolved{candidates}` | Result entity | Origin unknown; candidates listed |

`Generated` may cross kinds
([L202-245](https://github.com/esaueng/remus/blob/087d6360e6299f357f9b662fe6ebe42ffc1a9aab/crates/topology/src/journal.rs#L202)).

Stated guarantees:

- **Ordinals, not arena ids.** Entries store `JournalOrdinal`s. `OpId` and
  ordinals are never reused, including across restores (L60-101).
- **Scope.** An entity outside an entry's scope carries through unchanged.
  An entity inside the scope with no claim is *severed*. "Absent claims are
  gaps … never implicit preservation" (L33-53).
- **Gap detection.** Any mutation the journal was not told about makes the
  next `journal_begin` insert a `GlobalBarrier` (L19-31).
- **Atomicity.** Scope creation, geometry and recording share one
  transaction, so a refusal publishes no history (fixed for shell, split,
  boolean and pattern)
  ([audit L162-205](https://github.com/esaueng/remus/blob/087d6360e6299f357f9b662fe6ebe42ffc1a9aab/docs/kernel-maturity/evolution-audit.md#L162)).
- **Persistence.** Arena documents (`serializeSolids`) carry the journal as
  an optional section. Entities missing from the document restore as
  `UNMAPPED`. STEP carries no history
  ([§7](https://github.com/esaueng/remus/blob/087d6360e6299f357f9b662fe6ebe42ffc1a9aab/docs/design/evolution-contracts.md#L158)).
- **Determinism.** Events are "sorted by subject ordinal (deterministic)".
  RFC 0003 says determinism is pinned by native double-run tests.

These calls return only `{solid|compound, op}`; coverage is from
[audit L29-48](https://github.com/esaueng/remus/blob/087d6360e6299f357f9b662fe6ebe42ffc1a9aab/docs/kernel-maturity/evolution-audit.md#L29)
and the binding docs
([evolution.rs L1213-1500](https://github.com/esaueng/remus/blob/087d6360e6299f357f9b662fe6ebe42ffc1a9aab/crates/wasm/src/bindings/evolution.rs#L1213)):

| Entry points | Recorded kinds | Caveats (stated) |
|---|---|---|
| `fuseJournaled` / `cutJournaled` / `intersectJournaled` | F/E/V from the GFA | Consumed inputs are *scope-severed*, not `Deleted`: "the GFA records no face deletions" (§9.2) |
| `filletJournaled`, `chamferJournaled` | Faces only | Edge and vertex references on the solid are cut. The native fillet cascade can return a `Geometry` map (per-feature fallback, [blend_ops.rs L3295-3303](https://github.com/esaueng/remus/blob/087d6360e6299f357f9b662fe6ebe42ffc1a9aab/crates/operations/src/blend_ops.rs#L3295)), journaled as inference. Also returns `isPartial` and `failedEdges` |
| `linearPatternJournaled`, `circularPatternJournaled`, `gridPatternJournaled` | Total F/E/V | The original is modified into itself. Copies are `Generated` from their source, so lineage never reaches a copy |
| `moveFacesJournaled` (+`WithQuality`, `Prepared…`) | F/E/V for planar and coaxial-bore moves | Ambiguous blend boundaries record faces only |
| `replaceSurfaceJournaled`, `resizeCylindricalFaceJournaled` | F/E/V on qualified cases | Unrestricted supports and surface-type changes are unqualified |
| `resizeBlendJournaled`, `removeBlendsJournaled` | F/E/V for a single cylindrical band between planar supports, and for recognized blend regions | Ambiguous cases refuse atomically |
| `commitPreparedGroupEditJournaled` | Same entry as `resizeBlendJournaled` or `resizeCylindricalFaceJournaled` | A refusal restores topology and history |
| `draftJournaled` | Planar draft, unique correspondence | Ambiguous boundaries stay unresolved |
| `defeatureJournaled` | Copy, merge, deletion and seam maps | General wounds are unresolved |
| `fixShapeWithConfigJournaled`, `runHealPipelineJournaled` | Composed healing history, including `unify_same_domain` and sewing | Untracked replacements stay unresolved |
| `imprint`, `imprintPlanarPolygon` | Construction-derived split of the target face | `imprint` records tool entities as `Preserved`. Polygon patches keep the original plane |

`journalSummary()` returns `{op, kind, type, detail}` per entry, where
`detail` is `{origin, events: <count>}` or `{affected: <count>}`
([L869-896](https://github.com/esaueng/remus/blob/087d6360e6299f357f9b662fe6ebe42ffc1a9aab/crates/wasm/src/bindings/evolution.rs#L869)).
It is counts-only by design. There is **no WASM call that lists an entry's
events or `Generated.sources`**. evolution-contracts §8 still cites the old
binding lines 502-531.

`journalBarrier(kind, solid)` records an explicit barrier over every entity
of the solid
([naming.rs L417-426](https://github.com/esaueng/remus/blob/087d6360e6299f357f9b662fe6ebe42ffc1a9aab/crates/wasm/src/bindings/naming.rs#L417)).

## 2.7 Persistent references and resolution

The model is in
[`topology/src/naming.rs`](https://github.com/esaueng/remus/blob/087d6360e6299f357f9b662fe6ebe42ffc1a9aab/crates/topology/src/naming.rs#L1),
the codec in
[`io/src/naming_io.rs`](https://github.com/esaueng/remus/blob/087d6360e6299f357f9b662fe6ebe42ffc1a9aab/crates/io/src/naming_io.rs#L1),
and the bindings in
[`wasm/src/bindings/naming.rs` L386-553](https://github.com/esaueng/remus/blob/087d6360e6299f357f9b662fe6ebe42ffc1a9aab/crates/wasm/src/bindings/naming.rs#L386).

```ts
resolveOperationOutput(op: number, kind: 'face'|'edge'|'vertex', index: number): string
makeOperationOutputRef(op: number, kind: string, index: number): string
captureSignatureRef(kind: string, handle: number, quantum: number): string
addRefDiscriminator(ref: string, d: 'surfaceType'|'curveType', tag: string): string
resolveRef(ref: string): string
resolveRefFaceAttributes(ref: string): string   // throws on non-binding
```

Anchors are `OperationOutput{op, index}`, `LineageOf{base}` and the
inference-tier `Signature`. Resolution returns `status` ∈ `bound`,
`boundMany`, `ambiguous`, `dangling`, `unresolvedAcrossOperation`,
`unknownOperation`, `noMatch` or `stale`, with `provenance` set to
`construction` or `inferred`
([naming.rs L72-116](https://github.com/esaueng/remus/blob/087d6360e6299f357f9b662fe6ebe42ffc1a9aab/crates/wasm/src/bindings/naming.rs#L72)).

Stated guarantees:

- **Identity claims only.** Lineage follows `Preserved`, `Modified` and
  `Merged` only. `Generated` is never followed (naming.rs L31-33).
- **Splits** resolve as `BoundMany`, sorted.
- **Fail closed.** A barrier, an unclaimed in-scope entity, or a possible
  `Unresolved` absorption gives `UnresolvedAcrossOperation`; a contested
  deletion severs rather than returning `Dangling`
  ([§9.1](https://github.com/esaueng/remus/blob/087d6360e6299f357f9b662fe6ebe42ffc1a9aab/docs/design/evolution-contracts.md#L223)).
- **Deterministic.** "identical history plus identical reference resolves
  identically" (naming.rs L323-329).
- **Provenance becomes `inferred`** after any hop through a geometry entry
  (L598).
- **`OperationOutput` index.** The outputs are the entry's subjects of that
  kind, excluding `Deleted`, "in the entry's deterministic event order".
  `Unresolved` subjects are counted
  ([L341-381](https://github.com/esaueng/remus/blob/087d6360e6299f357f9b662fe6ebe42ffc1a9aab/crates/topology/src/naming.rs#L341)).
  That order is *subject ordinal* order. Ordinals are assigned on first
  sight in this sequence: pre-scope, then the result solids' faces, edges
  and vertices in traversal order, then the event subjects
  ([journal.rs L603-608](https://github.com/esaueng/remus/blob/087d6360e6299f357f9b662fe6ebe42ffc1a9aab/crates/topology/src/journal.rs#L603)).
  So output N is defined by allocation and traversal order, not by any
  semantic role *(inferred)*.
- **Codec.** Version 1, "read forever"
  ([naming_io.rs L9-11](https://github.com/esaueng/remus/blob/087d6360e6299f357f9b662fe6ebe42ffc1a9aab/crates/io/src/naming_io.rs#L9)).
  A reference is valid only "in any session holding the model's journal".
- **Signature references** are always `inferred`. Several matches give
  `ambiguous`, never the first match.
- Only the `SurfaceType` and `CurveType` discriminators shipped. RFC 0003's
  `AdjacentToRef`, `NearestTo` and `OutputRole` are not implemented
  (naming.rs L139-152).

**OpenZCAD** calls only `resolveOperationOutput`
([exact-lineage-builders.ts](../../../packages/kernel-adapter/src/exact-lineage-builders.ts)).
It reads pattern instance blocks and move-face maps by index and *checks*
the layout it depends on: index N must not bind, and each block must equal
the instance's face set. It never creates,
stores or resolves a `PersistentRef`. The `gcsAttachToFace` /
`gcsResolveRefs` linked-sketch APIs, which take references, are also unused.

## 2.8 Attribute propagation and face names

`propagateAttributesForOp(op, allowInferred)` returns
`{carried, unresolvedOutputs, mergeConflicts, refusedInferred}`
([topology.rs L1222-1258](https://github.com/esaueng/remus/blob/087d6360e6299f357f9b662fe6ebe42ffc1a9aab/crates/topology/src/topology.rs#L1222));
`setFaceName` and `getFaceName` write and read the per-face attribute. Stated
rules: attributes copy through `Modified` (to every split piece) and through
`Merged` only when all inputs agree. `Generated`, `Unresolved` and barriers
carry nothing, and geometry entries need `allowInferred`. The native twin
`propagate_face_attributes(map)` applies the same rules to an `EvolutionMap`
([evolution.rs L896](https://github.com/esaueng/remus/blob/087d6360e6299f357f9b662fe6ebe42ffc1a9aab/crates/operations/src/evolution.rs#L896)).
STEP round-trips names but not history. OpenZCAD uses none of these calls.

## 2.9 OpenZCAD consumption at a glance

All consumers live in `packages/kernel-adapter/src`: booleans in
[exact-boolean-evolution.ts](../../../packages/kernel-adapter/src/exact-boolean-evolution.ts)
(probe on copies, claims re-verified by witness); fillet and chamfer payloads
in [exact-edge-modifiers.ts](../../../packages/kernel-adapter/src/exact-edge-modifiers.ts)
(`construction` only); blend resize, cylinder resize and blend removal in
[exact-direct-edit-ops.ts](../../../packages/kernel-adapter/src/exact-direct-edit-ops.ts);
face moves in
[exact-face-distance.ts](../../../packages/kernel-adapter/src/exact-face-distance.ts)
and [exact-prepared-face-move.ts](../../../packages/kernel-adapter/src/exact-prepared-face-move.ts)
(strict `faceEvolution` decode or `resolveOperationOutput` indices); linear and
grid patterns in
[exact-feature-builders.ts](../../../packages/kernel-adapter/src/exact-feature-builders.ts)
(layout-checked output blocks plus a `journalSummary` census); and group edits
in [exact-prepared-group-edit.ts](../../../packages/kernel-adapter/src/exact-prepared-group-edit.ts).
Everything else in §2.0 is unused, including `circularPatternJournaled` (the
adapter calls plain `circularPattern`).

## 2.10 Gaps

Operations with **no lineage at the WASM boundary**:

- `shell*` and `split`/`splitBySheet`. Native `shell_journaled` and
  `split_journaled` record faces only and are not bound to WASM.
- `sweep*`, `loft*`, `helicalSweep*` ("No family-wide total journal
  coverage"), `mirror`, `thicken`, `offsetFace`, `pushPullFace`,
  `filletVariable`, `fuseAll`, `cutThreadDetailed`, `cutGearTeethDetailed`.
- Standalone `unifyFaces` and `sewFaces`; a journaled route exists only
  through `runHealPipelineJournaled`.
- Every typed `*Detailed` entry point, the geometry path OpenZCAD ships.
- STEP and mesh import, which arrive with an empty journal.

Operations with **partial lineage**:

- **Faces only:** fillet and chamfer creation, journaled or payload, and
  ambiguous blend moves. Edge and vertex references are cut across them.
- **Boolean deletion.** The legacy map builds `deleted` by set difference.
  The entity payload has no deleted bucket. The journal scope-severs
  consumed inputs. These three spellings are a known inconsistency, listed
  in §10 of evolution-contracts.
- **Post-processing.** Boolean evolution describes the body before
  unification: a 14-face history against a 6-face shipped union, per
  OpenZCAD's roadmap
  ([kernel-roadmap-remus.md §C1](../../../docs/kernel-roadmap-remus.md)).
- **Vertex detail.** Boolean `created` vertices and `generated` edges carry
  no witness that a consumer could use to verify them.
- **Hidden lineage.** `booleanRegions` validates lineage it never returns.
  Journal `Generated.sources` and event lists cannot be read from JS.
- **Offset and revolve** coverage is bounded as in §2.5.

## 2.11 Open questions for the review

1. **One contract or several?** There are four payload shapes (legacy map,
   Issue-12 entity JSON, `FaceEvolutionPayloadV1`, result-aware F/E/V).
   Should Remus converge on the versioned result-aware shape, and OpenZCAD
   consume only that?
2. **Same-call geometry and lineage.** OpenZCAD probes booleans on copies
   because the entity-evolution boolean diverged on an earlier pin. Can
   Remus add evolution to the `*Detailed` paths, with the byte-identical
   guarantee fillet already has?
3. **Index semantics of `OperationOutput`.** OpenZCAD depends on output N
   following instance-major source-face order, checking that order rather
   than having it stated. Should Remus document the order, or expose
   per-output source and role (`OutputRole`) so consumers stop reading
   positions?
4. **Journal versus in-band maps.** Should OpenZCAD adopt the journal and
   `PersistentRef` as its identity spine, or keep witness-verified names with
   kernel claims as candidate evidence only? That decides whether
   `GlobalBarrier` gaps from unjournaled calls matter.
5. **Unification history.** Is `runHealPipelineJournaled(["unify_same_domain"])`
   after a journaled boolean an acceptable stand-in for the missing
   "unify with evolution"? Who owns qualifying it?
6. **Deletion spelling.** Should booleans emit explicit `Deleted` events, at
   the risk of an inference carrying a `Construction` label, or should the
   legacy map stop synthesising them? OpenZCAD's decoders treat absence
   differently on each path.
7. **Priority.** Remus plans shell, split, then sweep/loft/revolve (B18). Does
   that match OpenZCAD's K05 order?
8. **Cross-version stability.** Handles and ordinals last only for the
   session, and the codec is v1. What upgrade path does a saved OpenZCAD
   document need if it ever stores Remus references or journals across a
   kernel bump?
