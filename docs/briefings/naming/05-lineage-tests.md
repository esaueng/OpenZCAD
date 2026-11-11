# 5. Existing lineage tests

**Method.** I read 23 known lineage test files at `c73dccff3`, then grepped
all `*.test.ts`/`*.spec.ts` for lineage-related terms; the most relevant extra
hits follow the catalogue. I did not run any suite. Case counts are expanded (`it.each` rows counted), with the declared
count in parentheses where it differs. "Real kernel" means geometry built in
Remus (`createExactKernelAdapter()`/`syncDocument` or `new RemusKernel()`);
"synthetic" means hand-built witnesses fed to a pure function.

**How these run.** `test/**/*.test.ts` and `packages/*/src/**/*.test.ts` are
the root Vitest project; `apps/web/src/**` is the web project
([unit-suites.mjs](../../../scripts/unit-suites.mjs)). CI runs the smoke
manifest [unit-ci-files.json](../../../test/unit-ci-files.json) plus Vitest's
affected-file inventory; kernel or dependency updates select full suites, and
`daily-validation.yml` runs everything ([ci-qualification.md](../../ci-qualification.md)).
Only **3 of the 23 files** are in the smoke manifest. Playwright CI selects
`@ci-smoke` cases.

## Summary table

| File | Suite | CI smoke? | Cases | Proves (short) |
|---|---|---|---|---|
| [topology-lineage.test.ts](../../../packages/kernel-adapter/src/topology-lineage.test.ts) | root | no | 19 | Witness hashing, evolution verification and the resolver's rung order (synthetic) |
| [face-attachment.test.ts](../../../packages/kernel-adapter/src/face-attachment.test.ts) | root | **yes** | 14 | Face-attached sketch frames follow lineage, refuse deletion/ambiguity, and rotate continuously (synthetic) |
| [remus-lineage.test.ts](../../../packages/kernel-adapter/src/remus-lineage.test.ts) | root | **yes** | 27 (19) | Remus move/modifier/transform lineage carries unique survivors; split/merge/delete refused (synthetic) |
| [remus-pattern-edge-lineage.test.ts](../../../packages/kernel-adapter/src/remus-pattern-edge-lineage.test.ts) | root | no | 7 | Grid edge names only for unique, re-verified source→copy pairs (synthetic, stub kernel) |
| [exact-operation-lineage.test.ts](../../../packages/kernel-adapter/src/exact-operation-lineage.test.ts) | root | no | 4 | Analytic-carrier carry and boundary-edge naming refuse twins/splits (mocked) |
| [lineage-message-determinism.test.ts](../../../packages/kernel-adapter/src/lineage-message-determinism.test.ts) | root | no | 5 | Published diagnostics identical under shifted kernel handles (real box, shifted handles) |
| [lineageDemand.test.ts](../../../apps/web/src/lib/lineageDemand.test.ts) | web | no | 6 | UI lineage demand is normalised, sticky per document, cleared on document change |
| [boolean-carrier-lineage.test.ts](../../../test/boolean-carrier-lineage.test.ts) | root | no | 5 | Boolean faces named by unique carrier; shared/split carriers hash-only (real kernel) |
| [boolean-evolution-lineage.test.ts](../../../test/boolean-evolution-lineage.test.ts) | root | no | 4 | Kernel entity evolution names two coplanar boss caps distinctly; pinned sketch stays on the right boss (real kernel) |
| [box-modifier-lineage.test.ts](../../../test/box-modifier-lineage.test.ts) | root | no | 3 (2) | Filleted/chamfered box republishes six side roles; a face offset survives an upstream width edit (real kernel) |
| [direct-edit-lineage-pins.test.ts](../../../test/direct-edit-lineage-pins.test.ts) | root | no | 8 | Lineage-resolved cylinder and blend resizes follow upstream edits; hash-only variants fail closed (real kernel) |
| [face-distance-lineage.test.ts](../../../test/face-distance-lineage.test.ts) | root | no | 16 (11) | Face-distance moves keep all face names through chains, undo/redo and reload; tampering refused (real + synthetic) |
| [fillet-result-lineage.test.ts](../../../test/fillet-result-lineage.test.ts) | root | no | 4 | Stacked cylinder fillet survives a radius edit; hash-only control fails (real kernel) |
| [grid-native-vertex-lineage.test.ts](../../../test/grid-native-vertex-lineage.test.ts) | root | no | 9 (6) | Grid vertices named uniquely, stable through count growth and cold rebuild, refused when the cell is deleted (real kernel) |
| [grid-pattern-edge-lineage.test.ts](../../../test/grid-pattern-edge-lineage.test.ts) | root | no | 26 (8) | Grid edge names stable through count growth; 16 injected journal faults all decline (real kernel + spies) |
| [h02-lineage-mode-qualification.test.ts](../../../test/h02-lineage-mode-qualification.test.ts) | root | no | 25 (18) | Cached eager/idle lineage equals a fresh cache-disabled rebuild byte for byte (real kernel) |
| [history-focus-lineage.test.ts](../../../test/history-focus-lineage.test.ts) | root | no | 3 | History focus traces lineage back past the last boolean (real kernel, bracket demo) |
| [linear-native-vertex-lineage.test.ts](../../../test/linear-native-vertex-lineage.test.ts) | root | no | 15 (10) | LINEAR-pattern edges/vertices named; datum endpoints follow edits and refuse deleted members (real kernel) |
| [pattern-instance-lineage.test.ts](../../../test/pattern-instance-lineage.test.ts) | root | no | 15 (13) | Instance faces carry source name + instance; a sketch on instance 3 survives a count change (real kernel) |
| [region-extrude-lineage.test.ts](../../../test/region-extrude-lineage.test.ts) | root | no | 5 | Region-extrude side walls named after sketch segments; attached sketch survives a resize (real kernel) |
| [sphere-patch-lineage.test.ts](../../../test/sphere-patch-lineage.test.ts) | root | **yes** | 4 | Hemispheres and union seam pieces named; seam fillet survives a Cylinder radius edit (real kernel) |
| [topology-lineage-spike.test.ts](../../../test/topology-lineage-spike.test.ts) | root | no | 2 | Remus's declared evolution API and complete evolution records for six operations (real kernel) |
| [parameter-lineage-repair.spec.ts](../../../test/e2e/parameter-lineage-repair.spec.ts) | Playwright | no tag | 1 | A legacy hash-only document opened in Tweak gets its references upgraded and survives eight parameter edits and a reload |

## Unit and model-level tests (synthetic inputs)

**topology-lineage.test.ts** pins the ADR-013 contract. `topologyHashOfWitness`
reproduces frozen ADR-011 fingerprints; reversed edges, negative normals and
carrier/class mismatches are `invalid`, closed free-form geometry
`unsupported`. `analytic-carrier` evolution is accepted only for an exact
plane/cylinder (a one-quantum plane shift is rejected); a `known-transform`
mismatch is rejected. The capability table reports chamfer and direct-edit
hash-only, with a control that primitive/sweep are `semantic` and transform,
import, fillet, boolean and pattern `derived`. The resolver: unique lineage
resolves, verified evolution may move away from the stored witness, two
claimants give `ambiguous-lineage`, unverified or replayed proofs give
`lineage-unverified`, a hash match without lineage gives `lineage-not-found`
(no silent rebind), hash fallback only for an explicitly unsupported
operation, `legacy-hash` for pre-v5 references (failing on collision), and
`invalid-reference` when a reference's hash disagrees with its own witness.

**face-attachment.test.ts** (smoke) tests `resolveFaceAttachment`. The frame
follows a dimension change and a 90° rotation by lineage, independent of
normal sign and candidate order. Deletion, ambiguity, a non-planar result and
NaN/zero normals each fail with a typed reason; an exact but unnamed face at
the stored position is **not** used. The origin moves to the centroid only
for sketches whose snapshot recorded one. Four sweep tests (2,000 steps) cap
any single-step frame rotation at 0.5°, covering the 45° world-axis tie and
the sign-canonicalisation boundary that used to mirror sketches.

**remus-lineage.test.ts** (smoke). `decodeMoveFaceEvolution` keeps the one
unique survivor, marks split/merged/deleted sources conflicted, and throws on
nine incomplete or `inferred` payloads. Duplicate semantic roles publish
nothing. Modifier lineage gives a unique blend band to the modifier, carries
direct-edit supports only through unique construction identities, drops an
earlier blend whose witness changed or split, and falls back to `hash-only`
on duplicate geometry, malformed evolution or a foreign result solid. Rigid
transforms keep identity only through exactly transformed witnesses; a 37°
off-grid rotation survives rounding, but a near twin is a split and a 5-unit
shift a delete; uniform scale needs an opt-in; mirror, shear and non-uniform
scale are rejected.

**remus-pattern-edge-lineage.test.ts.** One stub-kernel case declines an
understated journal event count before any ordinal scan. Six synthetic cases
show edge names `pattern.edge.instance.1-0.source.edge.N` and refusal of stale
hashes/witnesses, duplicate or conflicting source roles, ambiguous/incomplete
/phantom journal sets, and closed NURBS.

**exact-operation-lineage.test.ts** mocks `topologyCandidatesForSolid` and
stubs the kernel: `carryAnalyticFaces` drops names on split results, source
twins, forged hashes or duplicate identities; `withBoundaryEdgeLineage` names
an edge only when exactly one edge joins two named faces.

**lineageDemand.test.ts** (web) covers normalisation, pick- and
command-driven demand, and the hook's never-shrink/clear-on-project-change
behaviour. It does not check delivery to the adapter
(`boolean-evolution-demand.test.ts` does).

## Kernel-integration tests (real Remus)

All build documents with `document-core` commands and call
`adapter.syncDocument`. With no `lineageDemand` the boolean evolution probe
runs eagerly, so booleans here are probed unless stated otherwise.

**boolean-carrier-lineage.test.ts.** A plate plus boss names all 11 faces
(e.g. `boolean.face.target.primitive.box.face.z-max`); a sketch-pinned extrude
on the boss cap keeps its z-range after the plate widens (only `bbox.z` is
checked); a through-slot leaves split faces unnamed; a two-box union leaves
shared planes unnamed.

**boolean-evolution-lineage.test.ts.** Two equal-height bosses share one cap
plane, defeating the carrier rule; entity evolution gives the caps **distinct**
names with no carrier/evolution disagreement, and a pin on the left boss stays
at x=10 after a plate resize. A stacked-box union must come back as the plain
fuse (6 faces, 12 edges); the lineage given up is not asserted. In a cut,
untouched plate edges keep `boolean.edge.target.*` names and pocket edges stay
unnamed.

**box-modifier-lineage** and **region-extrude-lineage** are as the table
states; the latter also shows overlapping rectangles leave the two split wall
pieces unnamed.

**pattern-instance-lineage.test.ts.** All 18 faces of a three-instance row are
uniquely named with the instance in the name, and a swap of two native outputs
is caught by witnesses. A sketch on instance 3 keeps its x when the count goes
from 4 to 6. Overlaps fall back to hash-only copy-and-fuse; kernel refusal
keeps the body with witness-derived names and a diagnostic.

**grid-pattern-edge-lineage.test.ts** uses a real kernel with `vi.spyOn`
fault injection. All 72 edges are named and retained exactly once through
count growth; reversing output ordinals changes nothing; 16 injected journal
faults all decline (edge names dropped, face names kept). A datum on cell 2-1
follows edits and a cold adapter and is refused when the cell is deleted.

**grid-native-vertex-lineage.test.ts** and
**linear-native-vertex-lineage.test.ts** do the same for vertices: every
vertex uniquely named at its closed-form position, three incident edges each;
names stable through count growth on a **separate cold adapter**; touching
members not welded; no vertex ordinals spent on 100-box or multi-source cases;
overlapping LINEAR members claim no boundary identity. A vertex-based datum is
re-qualified through edits, checkpoint restore, undo/redo and cold replay, and
refused once its member is deleted.

**sphere-patch-lineage.test.ts** (smoke). Hemispheres are named by pole, even
though their ADR-011 hashes remain identical. Union seam pieces 0–3 are named,
each joining a cylinder and a sphere face; names hold through undo/redo and a
fresh-adapter reopen (explicit `lineageDemand`). A named seam fillet survives
a Cylinder radius change while the hash-only control fails; imported STEP
hemispheres stay unnamed.

**history-focus-lineage.test.ts** uses loose bounds (`>= 2`, `> 0`).

**topology-lineage-spike.test.ts** characterises Remus: the `.d.ts` declares
`FaceEvolutionPayloadV1` and the `*WithEvolution` methods; set equality proves
every result face is claimed for primitive, sweep, transform, boolean, fillet
and both chamfers; a fillet band is `generated` from both parents, never
`modified`; the evolution fuse returns 14 fragment faces against production's
six.

## Regression and determinism tests

**fillet-result-lineage.test.ts** reproduces a reported failure (cylinder →
fillet → fillet → radius drag). With references, the stacked fillet survives
radius 6.4 and matches a from-scratch volume; without them it fails with the
exact "A selected edge no longer exists" warning. A box fillet yields unique
`boundary.edge.*` names, one fillet-owned band, and primitive ownership for
the two untouched sides.

**direct-edit-lineage-pins.test.ts.** `resize-cylindrical-face` follows height
and source-radius changes, and its hash-only twin fails closed. `resize-blend`
on a filleted plate **exported to STEP, re-imported and transformed** follows
the move; hash-only fails closed. Resizing to R0 removes the band via
construction evolution; a downstream face-distance edit then resolves by pair
names, rebuilds identically on a **fresh adapter** from JSON, and the deleted
blend's old reference is refused.

**face-distance-lineage.test.ts** (synthetic STEP import). One-sided and
symmetric moves keep all six names; chained edits survive full replay of an
upstream change; undo, redo and a JSON reload (same adapter) keep identical
names; a tampered `lineageName` is refused as "stale", not rebound to a
neighbour. Eleven synthetic cases cover journal/witness agreement and journal
decoding.

**lineage-message-determinism.test.ts** drives five diagnostic producers on a
real box twice, with handles shifted by 4,000, and requires byte-identical,
digit-free messages (and at least one, so it cannot pass vacuously).

**h02-lineage-mode-qualification.test.ts** compares every warm cached response
with a cache-disabled fresh rebuild (raw B-rep bytes and publication) and
with its own repeat, across eager (no demand) and idle (`[]`) modes; idle
must never call `probeBooleanEntityEvolution`. Scenarios include metadata
accounting, partial demand, transforms, mode switches with persisted boolean
edge consumers, probe failure, eviction, replay-budget recycling and seven
extrusion variants.

## End-to-end

**parameter-lineage-repair.spec.ts** (no `@ci-smoke` tag) builds the
stepped-bore document with mostly hash-only picks in Node, seeds IndexedDB and
opens it in Tweak. It polls until six direct-edit/fillet features have
**persisted** references, edits eight parameters without alerts, sees `-1`
refused without a version bump, and after reload finds the values, zero
warnings and no console errors.

## Adjacent tests

All root Vitest and outside smoke unless noted.
[exact-boolean-evolution](../../../packages/kernel-adapter/src/exact-boolean-evolution.test.ts)
and [remus-boolean-evolution](../../../packages/kernel-adapter/src/remus-boolean-evolution.test.ts)
trust an evolution payload only when it is proven against the shipped body.
[remus-native-vertices](../../../packages/kernel-adapter/src/remus-native-vertices.test.ts)
(**smoke**) checks vertex proofs across checkpoints.
[topology-resolution](../../../test/topology-resolution.test.ts) pins the
**web** ladder, which falls through to hash on a lineage miss. The
[boolean-evolution-demand](../../../test/boolean-evolution-demand.test.ts)
family pins when the probe runs.
[edge-reference-repair](../../../test/edge-reference-repair.test.ts) and
[stepped-bore-parameter-replay](../../../test/stepped-bore-parameter-replay.test.ts)
are the unit side of the e2e repair loop.
[partial-revolve](../../../test/partial-revolve.test.ts) shows partial turns
are hash-only. The parity
[corpus](../../../test/parity/corpus.spec.ts) pins lineage-name sets and hash
digests per entry across kernel updates.

## Coverage gaps

**Operations without a lineage test.** I found no naming or survival test for
loft, shell, mirror, draft, thread, text emboss (H02 tests caching only),
intersect booleans, or imported meshes (declared hash-only, never exercised).
Holes appear only incidentally (`hole.face.bore` in
`picked-feature-deletion.test.ts`); chamfer lineage only on boxes and grid
cells; revolve only in `partial-revolve.test.ts`.

**Reference kinds.** Vertex references are exercised only through datum
consumers on patterns. No test replays a vertex reference on a primitive,
boolean or fillet body through an upstream edit.

**Mock-only assertions.** Every resolver-ladder rule (ambiguous lineage,
unverified evolution, no silent rebind, unsupported-only fallback,
`legacy-hash`) is asserted only on hand-built candidates. Integration files
assert outcomes (name present/absent, warning, volume), never which rung
resolved. `exact-operation-lineage` and most of `remus-pattern-edge-lineage`
never touch Remus.

**Properties never or weakly asserted.**

- *Two ladders disagree, both pinned.* The kernel resolver treats a lineage
  miss as `lineage-not-found`; the web `topologyResolution` "falls through to
  the hash when lineage no longer exists". No test states which consumers use
  which.
- *Split/merge.* Only refusal is tested; no user-facing outcome (re-pick
  prompt, piece choice) beyond warning text.
- *Determinism across versions.* Within one kernel version it is well covered
  (handle shift, H02, cold adapters, reversed ordinals). Across Remus updates
  the parity corpus pins only name **sets** and hash digests; no golden
  document with stored v5 references is replayed.
- *Schema migration.* Every fixture uses `witnessVersion: 1`; no test migrates
  a stored reference between document schema versions. Legacy handling is
  tested only at runtime (legacy-hash rung, repair advice, fixed-frame
  conversion in `faceSketchAttachment.test.ts`).
- *Operand order.* Union names embed the operand slot; no test reorders
  `targetBodyIds`.
- *Routine CI.* The boolean, pattern, region, fillet and direct-edit pins run
  on a PR only when the affected-file inventory selects them.

## Open questions for the review

1. Should the kernel ladder (lineage miss is terminal) and the web ladder
   (falls through to hash) be unified? If not, which consumers may use the
   permissive one, and what test enforces it?
2. `topologyLineageCapability` marks chamfer and direct-edit hash-only, yet
   chamfered-box sides and direct-edit faces carry names through
   Remus-specific derivations. Is the table only the generic verifier's gate,
   and should each entry be tied to a named integration test?
3. Is refusal the final policy for splits and merges, or should a test pin a
   repair behaviour (re-pick, largest piece, set)?
4. Should the parity corpus carry golden documents with stored v5 references,
   so a Remus update proves resolution rather than unchanged name sets?
5. Should at least one real-kernel boolean or pattern lineage pin join the
   smoke manifest, given that regressions here mis-bind or drop features
   silently?
6. Is operand order meant to be part of a boolean result's identity?
