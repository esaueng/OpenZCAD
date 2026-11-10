# 4. Recent reference-loss bugs and workarounds

This section lists the 20 most recent defects and workarounds whose root cause
was a lost, missing or mismatched topological reference. It covers OpenZCAD
and, where the cause was kernel lineage output, Remus.

**Method.** The OpenZCAD `origin/main` log was searched by subject keyword
(lineage, reference, attach, rebind, remap, stale, lost, mismatch, pin,
resolve, naming, topology, identity, provenance, evolution, fallback,
neighbour), then by path history of the lineage, attachment and
reference-resolution modules and of recent `fix`/`test` commits touching
fillets, holes, datums, patterns or direct edits. The Remus log was searched
the same way. Each candidate's PR description, and its diff where needed, was
read to confirm a reference defect.

**Range.** 2026-09-25 to 2026-11-09: 16 OpenZCAD changes and 4 Remus changes.

**Excluded after reading:** #1334 (a correct geometric refusal, badly
reported), #1333 and #1303 (display and highlight styling), #1025 (selection
granularity), #1301 (test timing), #1194, #1180, #1173 and #1164 (geometry
repairs), and Remus #1479 (refusal wording).

Entries are newest first. "OZ" marks OpenZCAD and **Remus** marks the
kernel.

---

## Entries

### 1. 2026-11-09 — OZ: split rim reported as "4 edges" in History

Commit [571efc0b](https://github.com/esaueng/OpenZCAD/commit/571efc0bb0fd422e11e9c598acec82012ff3ab15),
PR [#1313](https://github.com/esaueng/OpenZCAD/pull/1313).

- **Symptom:** A boolean left a unioned cylinder's rim as four quarter-arcs.
  The selection readout said "Closed edge 37.7 mm", but the committed
  fillet's History row and status line said "4 edges". Chamfers had the
  same mismatch.
- **Root cause:** The blend consumes the edges it rounds, so the body's
  current topology can no longer resolve the stored hashes and the summary
  could only count them. Replay is unaffected; display is not.
- **Fix type:** Workaround. The summary reads the quantized endpoints or
  `closed: true` stored in each `edgeReferences[i].witness` (ADR-011), and
  falls back to a plain count when witnesses are missing.
- **Tests:** `apps/web/src/lib/edgeLoops.test.ts`,
  `apps/web/src/lib/featureSummary.test.ts`.

### 2. 2026-11-08 — Remus: group re-fillet could not find the picked edge in its boundary history

Commit [40db6196](https://github.com/esaueng/remus/commit/40db61969be4b62f75821f47b9b6546c2d62efdb),
PR [remus#1608](https://github.com/esaueng/remus/pull/1608).

- **Symptom:** A free-end fillet (R1.5 or R3.7) whose tangent chain crossed
  an earlier R1 band was refused in OpenZCAD with "Can't round this edge
  here".
- **Root cause:** The fallback maps the picked edge through
  `SharpRestoration::boundary_history`, a binary-searched table built
  edges-then-vertices while `EntityKind` sorts vertices first, so every edge
  lookup missed. The reference existed; the lineage table was unsearchable.
- **Fix type:** Real fix (a 3-line sort).
- **Tests:** `crates/operations/tests/regress_group_fillet_selection_history.rs`.

### 3. 2026-11-07 — Remus: journaled blend-group edits rejected inferred history

Commit [0a2b13ee](https://github.com/esaueng/remus/commit/0a2b13ee4749da2b7178ebd082426936acf4f0c8),
PR [remus#1582](https://github.com/esaueng/remus/pull/1582).

- **Symptom:** Scalar edits of imported filleted solids worked. OpenZCAD's
  journaled edits of the same solids were still refused, because they need
  persistent face references.
- **Root cause:** The journaled entry points did not route through the newer
  blend-group rebuild. They also rejected the *inferred* successors of
  rebuilt bands and corners, so no face or boundary references survived.
- **Fix type:** Real fix, bounded. Journaled resizes route through group
  rebuilding, keep uniquely inferred successors, and journal edge splits and
  deletions with explicit ambiguity. `resizeBlendWithEvolution` V1 still
  reports inferred history as `unavailable`.
- **Tests:** `crates/wasm/src/bindings/gecko_edit_tests.rs`; extended
  `crates/operations/tests/blend_group_edit.rs` and `journal_resize_blend.rs`.

### 4. 2026-11-05 — OZ: sphere-boss seam fillet lost its edge when the boss radius changed

Commit [d91963ba](https://github.com/esaueng/OpenZCAD/commit/d91963baa54963f984010ec9113326c0b3fce0c9),
PR [#1254](https://github.com/esaueng/OpenZCAD/pull/1254). This is labelled
`feat` (K06), but it closes a reported break.

- **Symptom:** A fillet on the seam between a cylinder boss and a primitive
  sphere broke with "A selected edge no longer exists" as soon as the boss
  radius changed.
- **Root cause:** The sphere's two hemispheres share one ADR-011 witness, so
  both were hash-only and witness carry treated them as an unresolvable
  split. The boss-sphere seam had no named face pair, so the fillet held it
  by a dimension-dependent hash.
- **Fix type:** Real fix. Hemispheres are named `z-max`/`z-min` by the pole
  each patch holds, a `WitnessTieResolver` settles twin witnesses, and seam
  pieces are named `piece.i.of.n`. Naming fails closed on ties, and the
  boss wall's own seam line stayed `unresolved` (see entry 5).
- **Tests:** `test/sphere-patch-lineage.test.ts`,
  `packages/kernel-adapter/src/exact-sphere-patches.test.ts`.

### 5. 2026-11-05 — Remus: boss seam line reported `unresolved` after a ring banded the wall

Commit [594bc62e](https://github.com/esaueng/remus/commit/594bc62e6f8e36bad86f1ee8f9208b307ac0d89b),
PR [remus#1553](https://github.com/esaueng/remus/pull/1553).

- **Symptom:** A fillet on a boss fused into a block or a sphere lost its
  edge after an upstream dimension change. This is the gap left open by
  entry 4.
- **Root cause:** When a ring cuts a cylinder or cone wall, three
  face-splitting routines re-emit the wall as stacked bands and rebuild its
  seam line with `source_topo_edge: None`, so evolution reported that edge
  `Unresolved`.
- **Fix type:** Real fix. A rebuilt seam piece inherits the source of the
  covering seam span only when all covering spans agree; otherwise it stays
  unresolved.
- **Tests:** `crates/operations/tests/regress_boolean_seam_edge_lineage.rs`,
  `crates/wasm/src/bindings/seam_edge_lineage_tests.rs`.

### 6. 2026-11-04 — OZ: Undo/Redo dropped the hole's bore selection

Commit [bb9ec0c6](https://github.com/esaueng/OpenZCAD/commit/bb9ec0c6648b15424f5c9888e2ec152d6ee79bf5),
PR [#1203](https://github.com/esaueng/OpenZCAD/pull/1203).

- **Symptom:** Undoing or redoing a hole resize rebuilt the geometry but
  cleared the face selection, removing the diameter handle and bore
  highlight.
- **Root cause:** The active hole's face selection was not carried across
  the history rebuild, and the restored body offered no resolvable identity
  for it.
- **Fix type:** Workaround (geometric rebinding). The active hole
  re-attaches to the matching inward cylinder in the restored geometry,
  using triangle winding to reject coaxial outer stock and refusing
  ambiguous bores, then refreshes its topology reference.
- **Tests:** `test/e2e/through-hole-chamfer-resize.spec.ts`,
  `apps/web/src/lib/interaction/cylinderRadius.test.ts`.

### 7. 2026-11-04 — OZ: hole resize preview highlighted the whole body instead of the bore

Commit [7b119948](https://github.com/esaueng/OpenZCAD/commit/7b11994856953c2ded13133164c458f2e354aa58),
PR [#1199](https://github.com/esaueng/OpenZCAD/pull/1199).

- **Symptom:** While a chamfered hole was being resized, the selection
  highlight fell off the bore and washed the entire parent body.
- **Root cause:** Preview-frame selection matched the bore by its axial
  endpoints. Resizing a chamfered hole moves those endpoints, so the bore no
  longer matched in the preview mesh and the selection fell back to the
  owning body.
- **Fix type:** Workaround (geometric matching). The bore is now matched by
  axis, overlapping span and the radius of the displayed worker frame, not
  by a stable identity.
- **Tests:** `test/e2e/through-hole-chamfer-resize.spec.ts`,
  `apps/web/src/lib/interaction/cylinderRadius.test.ts`.

### 8. 2026-11-01 — OZ: false "existing fillet" refusals and dropped picks when editing a blend

Commit [9d952eb0](https://github.com/esaueng/OpenZCAD/commit/9d952eb0b7e6ef373b88c87492e13af131669287),
PR [#1114](https://github.com/esaueng/OpenZCAD/pull/1114).

- **Symptom 1:** Users were told "Edges that end on an existing fillet or
  chamfer…" when no fillet had made the face, even with the only earlier
  fillet suppressed.
- **Root cause 1:** `isBlendFace` decided by shape alone, not provenance.
- **Symptom 2:** Adding an edge while editing a fillet silently dropped it,
  with "a saved pick no longer exists".
- **Root cause 2:** Edit-mode clicks are remapped to the input body by
  fingerprint. A trimmed edge has no counterpart there, so the click stored
  a result-body hash that the next pick refresh pruned.
- **Fix type:** Real fix plus guard. A face counts as a prior blend only
  when its lineage names an earlier active fillet or chamfer as producer
  (ignored for bodies collapsed from several solids). An unmappable
  edit-mode pick is refused at once with the real reason.
- **Tests:** `packages/kernel-adapter/src/exact-prior-blend.test.ts`,
  `apps/web/src/lib/inPlace/blendEdgeRemap.test.ts`.

### 9. 2026-11-01 — OZ: a direct edit's result was attributed to the next selection

Commit [23ac491b](https://github.com/esaueng/OpenZCAD/commit/23ac491bd999c04487de394d7c8b854f2d3ab2b2),
PR [#1097](https://github.com/esaueng/OpenZCAD/pull/1097).

- **Symptom:** In production QA, a box face showed a gear edit's refusal and
  an 11 mm chip (8 mm plus the gear's +3). A commit could also steal the
  user's new pick. No geometry went to the wrong body.
- **Root cause:** The asynchronous exact check applied its result to the
  *current* selection; the operation carried no identity of its target.
- **Fix type:** Guard. An `operationSelectionKey` is compared at
  completion; if the selection changed, the refusal is named for the edited
  body and a commit leaves the new selection alone.
- **Tests:** `test/e2e/direct-edit-ownership.spec.ts`,
  `apps/web/src/lib/interaction/machine.test.ts`.

### 10. 2026-10-31 — OZ: gear cap offset refused after a History edit stored a mismatched hash/reference pair

Commit [08283718](https://github.com/esaueng/OpenZCAD/commit/082837186060ff8826a842bd973cfdd9d354bacc),
PR [#1093](https://github.com/esaueng/OpenZCAD/pull/1093).

- **Symptom:** A gear cut into a cylinder loaded correctly but refused its
  next cap offset (81 → 86 mm).
- **Root cause:** A History edit seeded the editor from the live pick,
  saving the *live* face hash beside the *original* lineage reference.
  Replay resolved by that hash, in effect a legacy hash pick, which no
  longer matched after the height change.
- **Fix type:** Real fix. Gear replay resolves the reference with its own
  `currentHash`, and editor seeding and pick refresh keep the authored pair
  together. Missing lineage still refuses.
- **Tests:** `test/gear-stale-reference.test.ts`,
  `test/e2e/gear-stale-reference.spec.ts`, fixture generator
  `test/support/stale-gear-reference.ts`.

### 11. 2026-10-30 — Remus: a boolean's curved seams came back `Unresolved`

Commit [51a27801](https://github.com/esaueng/remus/commit/51a278015d6b96437d3f2b221d35e83046632a52),
PR [remus#1410](https://github.com/esaueng/remus/pull/1410).

- **Symptom:** On a round boss fused into a block, OpenZCAD could name only
  the straight part of the seam. Picking the arc over the block top, or the
  free-form piece over an earlier round, was refused before the kernel ran:
  "Edge modifier lineage is missing a reference".
- **Root cause:** The face splitter builds curved sections from the whole
  intersection curve, not from pave blocks. The resulting edges carried
  neither `pave_block_id` nor `source_topo_edge`, so `export_entity_evolution`
  could not chase them back to the face-face pair that made them.
- **Fix type:** Real fix (provenance-based fallback).
  `section_pairs_by_incidence` matches the edge's two result faces'
  recorded sources against the intersected face pairs. No geometry is
  consulted; seams and ambiguous pairs stay `Unresolved`.
- **Tests:** `crates/operations/tests/regress_boolean_curved_section_lineage.rs`.

### 12. 2026-10-22 — OZ: multi-source LINEAR pattern published no edge names

Commit [6c80509e](https://github.com/esaueng/OpenZCAD/commit/6c80509e755f509c109b1cd6a5f108dde9685245),
PR [#821](https://github.com/esaueng/OpenZCAD/pull/821). This is labelled
`feat`, but it closes a lineage gap.

- **Symptom:** A linear pattern of a two-solid source kept its geometry and
  face names but published *zero* named edges (expected 72) and no
  native-vertex proof. Edge picks on pattern instances were therefore
  hash-only and would break on an upstream edit.
- **Root cause:** Edge and vertex adoption was qualified only for a single
  journaled source, so with several sources the adapter withheld edge names
  entirely.
- **Fix type:** Real fix. Each source is qualified against its own journal
  under one feature-wide event budget; over budget, only vertex proof is
  withheld.
- **Tests:** `test/linear-native-vertex-lineage.test.ts`,
  `packages/kernel-adapter/src/remus-linear-native-vertices.test.ts`.

### 13. 2026-10-22 — OZ: point-based datums lost every vertex source at once

Commit [434323b4](https://github.com/esaueng/OpenZCAD/commit/434323b4f9ad78f362a73cded938e80bace63b6b),
PR [#802](https://github.com/esaueng/OpenZCAD/pull/802).

- **Symptom:** When the body supplying a datum's vertices disappeared,
  three-point and parallel-at-point planes and two-point axes lost all their
  sources and could not be repaired one at a time without intermediate
  invalid states.
- **Root cause:** Vertex references did not survive removal of their source
  body. No automatic successor exists, which is by design.
- **Fix type:** Workaround and repair tool. History lets the user re-pick
  some or all vertex roles as one preflighted, undoable update that keeps
  datum identity; each pick must be an unambiguous edge endpoint.
- **Tests:** `test/datum-vertex-repair.test.ts`,
  `test/datum-vertex-repair-exact.test.ts`,
  `test/e2e/datum-vertex-repair.spec.ts`.

### 14. 2026-10-21 — OZ: cached feature reuse published different lineage from a fresh build

Commit [1963e7f1](https://github.com/esaueng/OpenZCAD/commit/1963e7f1eafb94546e7c07cf82d5bcbdb3f8f437),
PR [#805](https://github.com/esaueng/OpenZCAD/pull/805).

- **Symptom:** This was latent and found by qualification. After an eager
  export or preview, the published face and edge references could differ
  from a cold idle build of the same document. The earlier conservative
  fallback stayed correct but lost cache reuse.
- **Root cause:** A checkpoint populated in "eager" probe mode carried
  lineage that a fresh "idle" build would not publish. Reusing the
  checkpoint made published references depend on the session's demand
  history rather than on the document.
- **Fix type:** Real fix. Checkpoints keep a finalized idle-lineage view
  qualified against the prefix's probe decisions.
- **Tests:** `test/h02-lineage-mode-qualification.test.ts`,
  `test/h02-unavailable-probe-reuse.test.ts`.

### 15. 2026-10-21 — OZ: record of sustained lineage mismatch across long sessions

Commit [bfd2128b](https://github.com/esaueng/OpenZCAD/commit/bfd2128bbe768e90b64a4fc3b2939fdab5c7b3fe),
PR [#799](https://github.com/esaueng/OpenZCAD/pull/799).

- **Symptom:** In an 80-edit session, B-rep bytes matched a fresh build but
  published references diverged after 20 edits until a worker restart.
- **Root cause:** Same as entry 14, reproduced on a two-box union (32
  differing paths, identical geometry).
- **Fix type:** Test-only record; entry 14 fixed the cause.
- **Tests:** `test/h02-exact-arena-equivalence.test.ts`,
  `test/h02-session-probe.test.ts`.

### 16. 2026-10-18 — OZ: offset datum plane with an unresolvable source face had no recovery

Commit [470844fb](https://github.com/esaueng/OpenZCAD/commit/470844fbf447e8163b5880bd73a0f64f0c6520d3),
PR [#726](https://github.com/esaueng/OpenZCAD/pull/726). This is a `feat`
slice that adds a repair path.

- **Symptom:** An offset plane whose source face no longer resolved could
  only fail, and its downstream sketches and features failed with it.
- **Root cause:** The face reference was lost upstream, for example after
  topology changed or the face was removed, and there was no supported way
  to rebind it.
- **Fix type:** Workaround and repair tool. "Re-pick source face…" makes
  the next planar face clicked the new source, keeping distance and
  direction, as one validated, undoable edit.
- **Tests:** `test/datum-face-repair.test.ts`,
  `test/e2e/datum-face-repair.spec.ts`.

### 17. 2026-10-02 — OZ: resizing a unioned bracket detached its inside-corner fillet

Commit [17cdfdbc](https://github.com/esaueng/OpenZCAD/commit/17cdfdbc5909c0f592c033ed886467076d3638a8),
PR [#537](https://github.com/esaueng/OpenZCAD/pull/537). This was finding
F1 of the 2026-10-01 design review.

- **Symptom:** A bracket was built from two boxes, a union, an inside-corner
  fillet and two holes. Changing `width` from 80 to 120 failed with
  "Fillet: A selected edge no longer exists" and "Hole target is
  unavailable".
- **Root cause:** The adapter named only `preserved` and witness-unchanged
  `modified` boolean edges. The union *generates* the corner edge, so the
  fillet held it by a position hash that moved with the width, and the
  holes on the fillet's result cascaded. The kernel already reported the
  generating face pair; the adapter ignored it.
- **Fix type:** Real fix. Generated edges are named
  `boolean.edge.between.<A>|<B>` when both source faces re-verify, the edge
  lies on both exact carriers, and the pair is unique. Trimmed straight
  edges keep their source name.
- **Tests:** `test/bracket-width-resize.test.ts`; extended
  `packages/kernel-adapter/src/remus-boolean-evolution.test.ts`.

### 18. 2026-10-02 — OZ: saved selections could bypass witness verification during topology recovery

Commit [5d93e645](https://github.com/esaueng/OpenZCAD/commit/5d93e645965303f2e9d6a00f4c6e00aa88c4af9d),
PR [#508](https://github.com/esaueng/OpenZCAD/pull/508).

- **Symptom:** No user report. A saved v5 selection could bind to a
  matching hash whose witness disagreed, so a reference could silently
  re-attach to the wrong entity.
- **Root cause:** Two recovery paths skipped the witness check: one when
  direct-edit lineage was absent, and one when an edge modifier collapsed
  several solids.
- **Fix type:** Guard. Both paths now require a unique, complete witness
  match; zero or ambiguous matches refuse. Proximity matching was
  deliberately not added.
- **Tests:** `packages/kernel-adapter/src/exact-reference-boundaries.test.ts`,
  `apps/web/src/components/ParameterRows.validation.test.tsx`.

### 19. 2026-09-30 — OZ: blend keys and lineage messages depended on kernel arena handles

Commit [27c3e213](https://github.com/esaueng/OpenZCAD/commit/27c3e2137f651bbaa92b082e54a189ecb137d64a)
(direct commit, no squash PR).

- **Symptom:** Warm and cold builds of identical geometry published
  different `blendRegionKey` values and lineage-diagnostic sentences.
- **Root cause:** Both quoted Remus arena handles, which are numbered
  differently after a checkpoint restore, so a transient handle leaked into
  a persistent-looking identity.
- **Fix type:** Real fix. `blendRegionKey` is now built from sorted member
  ADR-011 hashes and fails closed when one is missing.
- **Tests:** `test/h02-publication-determinism.test.ts`,
  `packages/kernel-adapter/src/lineage-message-determinism.test.ts`.

### 20. 2026-09-25 — OZ: parameter replay broke through native holes and direct edits

Commit [6d6ae239](https://github.com/esaueng/OpenZCAD/commit/6d6ae239cd531fbdcb1130f9e298b60964dcf981),
PR [#433](https://github.com/esaueng/OpenZCAD/pull/433).

- **Symptom:** A clean saved history could fail its next parameter edit
  after native holes, face offsets, bore resizes or rounds.
- **Root cause:** Native holes discarded the semantic face identities of
  their result, so downstream selections fell back to dimension-dependent
  hashes that a parameter change invalidated.
- **Fix type:** Real fix plus legacy migration. Holes publish verified face
  references and unique boundary-edge roles. After a clean rebuild,
  kernel-proven legacy picks are normalized atomically without an undo
  entry; stale or ambiguous picks still refuse.
- **Tests:** `test/stepped-bore-parameter-replay.test.ts`,
  `test/e2e/parameter-lineage-repair.spec.ts`,
  `packages/kernel-adapter/src/exact-operation-lineage.test.ts`. The design
  is in `docs/plans/parameter-reference-replay.md`.

---

## Tally

12 real fixes (two also add a guard or migration), 5 workarounds
(three geometric rebinds or stored-witness reads, #1, 6, 7; two repair UIs,
#13, 16), 2 guards (#9, 18), 1 test-only record (#15).

---

## Patterns

**1. Boolean edge evolution is the most frequent root source.** Five entries
(#1, 4, 5, 11, 17) trace back to edges a boolean generates or re-emits. The
kernel cases share one mechanism: a Remus emitter rebuilt an edge without
recording its source (`source_topo_edge: None`), so evolution fell back to
`Unresolved`. Each fix patched one emitter, and nothing checks emitters
generally. The adapter (#4, 17) repeatedly had to derive names from face
pairs and geometric evidence.

**2. Fillets and blends are the most common victims.** Eight entries (#1, 2,
3, 4, 5, 8, 11, 17) end in a fillet or chamfer that cannot find, add or
describe its edges. Edges are more often generated than preserved, and
blends consume their input edges, so those references cannot be resolved
after commit (#1, 8).

**3. Hash and reference duality causes silent downgrade.** In #10 a live
hash was saved beside the original reference and replay trusted the hash.
In #18 a matching hash could bypass witness verification. These are
document-integrity bugs, not kernel gaps.

**4. Published identity is not a pure function of the document.** In #14,
15 and 19, arena handles or probe-mode checkpoints leaked into published
identity. None was user-reported; warm-versus-cold oracles found all three.

**5. The UI layer rebinds by geometry.** The geometric workarounds (#1, 6,
7) and the attribution guard (#9) are in `apps/web`. They re-find entities
by axis, span, radius, winding or endpoints because preview frames and
restored bodies carry no resolvable reference. They refuse on ambiguity, but
they duplicate the lineage layer's job.

**6. Only datums have repair UI.** #13 and #16 give datums a re-pick flow.
Fillets, holes and sketch attachments still end at "A selected edge no
longer exists".

**7. Fail closed is consistent.** Every real fix refuses on ambiguity, and no
entry added nearest-match binding in the modelling path.

---

## Open questions for the review

1. **Should Remus guarantee complete evolution?** Entries 5 and 11 were
   found one emitter at a time, after user-visible breaks. Should a kernel
   contract test fail whenever a supported operation reports `Unresolved`
   for an edge with a recoverable source?
2. **Should a reference store one canonical identity?** In entry 10 the
   stored hash and lineage reference disagreed and replay trusted the
   weaker one. Should the hash be derived from the reference, or the pair
   validated at write time?
3. **Should selection, preview and summaries use lineage?** Three
   workarounds (#1, 6, 7) rebind by geometry. Should preview frames and
   undo/redo snapshots carry the committed build's published references?
4. **How should consumed references be kept?** Blends consume their input
   edges, breaking edit-mode remapping (#8) and display (#1). Should a
   feature's output lineage keep a resolved snapshot of its consumed inputs?
5. **Should the warm-versus-cold publication oracle be a required CI gate?**
   #14, 15 and 19 were caught only by qualification runs.
6. **Should the datum repair flow be generalized?** #13 and #16 show a
   staged, preflighted, undoable re-pick works. Should fillet, hole and
   sketch-on-face references get the same flow instead of a refusal?
