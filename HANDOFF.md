# Boolean entity evolution: real provenance for boolean faces and edges

Branch `claude/remus-boolean-evolution`, roadmap row **K05**. Stacked on
`claude/remus-kernel-patterns` (PR #331) — diff against that branch to see
only this work. The parent's own handoff is preserved verbatim at the bottom
of this file.

## What shipped

A boolean used to derive face identity from geometry alone. The
analytic-carrier rule (`deriveRemusBooleanCarrierLineage`) can name a result
face only when its quantized plane or cylinder holds exactly one named operand
face **and** exactly one result face. Two things break that constantly:

- a carrier two operand faces **share** — two bodies flush on one plane;
- a carrier holding several **result** faces — two bosses of the same height,
  whose caps land on one plane.

Both published nothing, so every face on those carriers fell back to the
ADR-011 hash, and an upstream dimension change moved the hash. That is the
failure this row exists for: a sketch pinned to one of two identical bosses
came back after a plate resize as

```
Sketch "On the left boss": legacy face attachment has no schema-v5 lineage
reference; using its stored migration frame.
```

The kernel's own entity-evolution payload names the operand face **every**
result face came from. Reading it keeps both boss caps identified, the sketch
resolves by name, and the warning is gone.

Edges came with it. The payload marks every result edge `preserved` /
`modified` / `generated` / `unresolved`. A `preserved` edge whose exact witness
is unchanged now keeps its operand's name:

```
boolean.face.target.primitive.box.face.z-max          (unchanged form)
boolean.edge.operand.0.primitive.box.edge.x.y-min.z-min   (new)
```

Measured on the parity corpus, an imported plate bored by a cylinder went from
**0 to 12** named edges, and the NURBS-cornered plate from 0 to 16 — with its
face names unchanged, because the carrier rule had already named all of those.

## The geometry invariant, and why this round is a redesign

**The shipped body does not come from the entity-evolution entry points, and
never did anything but provenance change.**

The first cut of this row routed the production booleans through
`cutWithEntityEvolution` / `fuseWithEntityEvolution` /
`intersectWithEntityEvolution` — the call is cheaper than doing the boolean
twice, and the eight prismatic fixtures tried agreed with the plain calls. That
was wrong, and a verifier found five separate consequences. On this pin those
entry points are **a different boolean implementation**, not the same boolean
with a payload attached. Measured directly on `4bbcd5c7` (each row reproduced
from a throwaway node script against `remus_wasm_node.cjs`, then again end to
end through the adapter):

| case | plain entry point | entity-evolution entry point |
| --- | --- | --- |
| cylinder r10 h20 minus sphere r8 at z=10 | 5 faces, 4137.839039 mm³ | throws `assembly failed: closed hole shell is not contained by any growth region` |
| sphere r10 intersect a 10 mm box at z=5 | 4 faces, 163.596637 mm³ | throws `assembly failed: no outer shell found (all shells classified as holes)` |
| two r10 spheres offset 5 mm, union | throws the **exact-only policy** refusal | returns a 4-face body, 5726.7768 mm³ |
| cylinder r10 h20 intersect sphere r8 at z=5 | throws the exact-only refusal | returns a 2-face body, 1946.740248 mm³ |
| cylinder r10 h20 union sphere r8 at z=20 | throws the exact-only refusal | returns **the sphere alone**, 4188.790205 mm³ |
| box 20 mm minus sphere r8 at (10,10,20) | throws the exact-only refusal | throws `copied face Id(49) does not contain exactly one reverse use of edge Id(276)` |
| cylinder r20 h5 union cylinder r5 h20 at z=5 | 6 faces | 5 faces |
| sphere r10 intersect a 10 mm box at the origin | 523.545492 mm³ | 523.528813 mm³ |

Rows 3–6 are the serious ones: the evolution entry points **do not apply the
kernel's exact-only policy** (Remus B21). A boolean the exact pipeline refuses
came back with a body, sometimes silently, once as one operand with the other
missing. That is a fail-closed violation and it regresses the contract PR #330
established.

So the two concerns are now completely separate:

- **Geometry** comes from the plain entry points, exactly as the parent branch
  wrote them — `kernel.cut`, `kernel.intersect`, `fuseUniformSolid` /
  `fuseAll`, with `tryExactCoaxialCylinderCut` in front of the cut and
  `unifyBooleanFaces` / `unifyUnionFaces` behind. Those calls carry the
  exact-only policy and its named refusal. The shipped solid, its refusal
  behaviour, its topology and its warnings are what the parent branch produces.
- **Lineage** is read afterwards by `probeBooleanEntityEvolution`, which
  repeats the boolean on `copySolid` **copies** of the same operands purely to
  read the payload. Its result is never the shipped body — the evidence type
  it returns does not even carry a solid handle.

### The payload is checked against the shipped body before it is believed

A payload that describes a different solid is not evidence about this one. So
the probe applies the caller's own post-processing to **its own** result and
compares that against the shipped body: face count, sorted face types, edge
count, and volume to a 1e-9 relative tolerance. Anything else — the probe
throwing, the payload failing to decode, the bodies differing — hands back
`declined` and the boolean keeps the analytic-carrier lineage it had before
this row, with the reason recorded as a diagnostic.

That one check is what catches every row of the table above: rows 1, 2 and 6
throw, rows 3–5 never reach the probe because the plain call refused and no
body was shipped, and rows 7 and 8 differ in face count / edge count / volume.

The payload's handles are the **copies'**, so the operands' own references are
carried onto the copies by exact witness (`carryRemusUnchangedLineage`, the
same uniqueness-checked carry a direct edit uses) before the derivation runs,
and the names it proves are carried back onto the shipped body the same way. A
name therefore only ever lands on a shipped face whose exact witness is
identical to the probe face the name was proved on. Nothing is matched by
handle, by list position or by proximity.

### The cost, stated plainly

**This performs the boolean twice** for every two-operand boolean feature: once
for the body the user gets, once on copies for the provenance. It also measures
witnesses on the two copies and on the probe's own result.

It runs on: a two-operand `boolean` feature (union, subtract or intersect)
whose operands are one solid each, and an add/cut extrude against a
single-solid target. It does **not** run — and says so in a diagnostic rather
than skipping silently — for a multi-solid operand, a union of three or more
bodies, a multi-tool subtract, or a cut the exact coaxial cylinder path took.

Measured: on the 175-case parity corpus the suite's test time is 9.2–9.5 s both
with the probe enabled and with it short-circuited to `declined` — no
measurable difference. At kernel level the second boolean costs roughly what
the first does (cut-through-a-plate: plain `cut` + `unifyFaces` 3.0 ms,
`copySolid` ×2 + `cutWithEntityEvolution` + `unifyFaces` 1.7 ms; cylinder onto
a plate: plain fuse 6.7 ms, evolution fuse 6.8 ms). If a rebuild profile later
shows this is the wrong trade on some path, the honest fix is to name that path
and decline the probe on it with a reason — not to trust an unverified payload.

### What stays hash-only, deliberately

- **`unresolved` edges.** The kernel declining. Never guessed past.
- **`modified` and `generated` edges.** There is no witness relation to check
  such a claim against, and an unverifiable claim is not evidence.
- **A source the kernel maps to several result faces.** A slot cut across a
  plate's top leaves two faces both honestly descended from the top; neither
  is the heir, so neither is named. Diagnostic `boolean-split-source`.
- **Faces with no exact analytic carrier** (free-form surfaces) — the
  ADR-013 boolean relation has nothing to verify.
- **Faces the production face-unification step merged.** Two named parents
  into one face is a merge, and a merge has no single name.
- **Every operation class whose probe does not reproduce the shipped body.**
  On the fixtures tried that is the stacked-box union (plain 6 faces / 12
  edges, evolution 6 / 16), the stepped coaxial cylinder union (6 vs 5 faces),
  and every curved-operand case in the table above. Those keep carrier lineage
  and are honestly reported as declining.
- **Booleans of more than two solids** — see Deliberate limits.

## Kernel calls adopted

| call | used for | replaces |
| --- | --- | --- |
| `cutWithEntityEvolution(a,b)` | provenance only, on copies | nothing — the cut still comes from `kernel.cut` |
| `fuseWithEntityEvolution(a,b)` | provenance only, on copies | nothing — the union still comes from `fuseAll` |
| `intersectWithEntityEvolution(a,b)` | provenance only, on copies | nothing — the intersect still comes from `kernel.intersect` |
| `copySolid(a)` | isolating the probe from the shipped operands | — |

No production geometry call was replaced. That is the point.

Decoding goes through the repo's own lineage machinery, as
`KERNEL-FINDINGS.md` requires — there is no `decodeEvolutionPayload` on the
pin. In `remus-lineage.ts`:

- `decodeRemusBooleanEntityEvolution` — strict decoder. Every malformed
  payload throws, including an edge event the pin does not publish: a kernel
  that grows a fifth event must make the caller decline the whole record, not
  quietly drop what it does not understand.
- `deriveRemusBooleanEvolutionLineage` — the derivation and its three gates.
- `reconcileRemusBooleanLineage` — see below.
- `carryRemusUnchangedLineage` — extracted from
  `propagateRemusUnchangedDirectEditLineage` (which now delegates to it,
  unchanged) so the boolean can move a reference between two bodies by exact
  witness. The boolean path uses it twice: operands onto their copies, and the
  proved names back onto the shipped body.

`exact-boolean-evolution.ts` holds the probe and the reconciliation.

## The architectural rule, as implemented

**Kernel history is candidate evidence; witnesses verify.** Nothing here takes
the kernel's word, and — after this round — nothing here takes its geometry
either.

1. **The probe's own body must be the shipped body**, by face count, face
   types, edge count and volume. Otherwise the payload is refused whole.
2. **The payload must partition the measured result.** The reported result
   faces must be exactly the probe result's measured faces, and every source
   must be a measured operand face. A payload that is not is refused *whole* —
   never consumed in part.
3. **The operand reference re-verifies** against the operand's own measured
   witness, so a reference the operand's own build had already invalidated
   cannot travel through the boolean.
4. **The transition satisfies the ADR-013 witness relation.** Every face claim
   goes through `verifyTopologyEvolution` with the `analytic-carrier` relation
   — the result face must lie on the same exact quantized carrier as its
   claimed source. Every edge claim goes through the `unchanged` relation.

**And the existing derivation was not deleted.** Both run on every boolean.
`reconcileRemusBooleanLineage` keeps each derivation's answers where only one
has one, and where the two name the same handle **differently it publishes
neither**, with a `boolean-evolution-disagreement` diagnostic. A disagreement
is a refusal, not a silent overwrite.

No disagreement was observed anywhere: not on the new fixtures, not across the
full root and web suites, not across the 175-case parity corpus. Since
reconciliation only ever drops on disagreement, "no disagreement diagnostics"
is also the proof that every name the carrier rule published before this
branch is still published.

## Regression coverage for the five reported failures

`test/boolean-evolution-geometry-invariant.test.ts` drives each one end to end
through the adapter. **Seven of its eight cases fail on the previous commit**
(checked by restoring the three changed sources, running the file, and
restoring the new ones):

| case | asserts |
| --- | --- |
| cylinder minus sphere at z=10 | builds, 5 faces, 4137.839039 mm³, no warnings |
| sphere intersect box at z=5 | builds, 4 faces, 163.596637 mm³, no warnings |
| cylinder intersect sphere at z=5 | **no body**, warning matches `exact-only policy` |
| cylinder union sphere at z=20 | **no body**, warning matches `exact-only policy` |
| two r10 spheres offset 5 mm | no body, named policy reason, and **not** `assembly failed` / `reverse use of edge` |
| box minus corner sphere | no body, named policy reason, and not the internal assertion |
| stepped cylinder union | 6 faces, 7853.981634 mm³ |
| sphere intersect box at the origin | 4 faces, **523.545492** mm³ |

`packages/kernel-adapter/src/exact-boolean-evolution.test.ts` pins the probe
itself: that an agreeing cut adopts the payload and publishes only onto shipped
handles, that the stepped cylinder union declines with `did not reproduce the
body`, that the cylinder-minus-sphere cut declines with `did not produce a
usable payload` while the five-face body is untouched, and that a declined
probe leaves the carrier lineage intact and records the reason.

`test/boolean-evolution-lineage.test.ts` (unchanged from the previous round)
keeps pinning the lineage the row is for, including the stacked union coming
back as the plain fuse built it — 6 faces, 12 edges.

## Check results

Run from the worktree root on the final tree.

| check | result |
| --- | --- |
| `pnpm lint` | `✖ 19 problems (0 errors, 19 warnings)` — the 19 pre-existing warnings |
| `pnpm typecheck` | clean, no output |
| `pnpm test` (root) | `Test Files 246 passed \| 2 skipped (248)` / `Tests 2520 passed \| 4 skipped (2524)` |
| `pnpm test` (web) | `Test Files 156 passed (156)` / `Tests 1182 passed (1182)` |
| `pnpm test:parity-corpus` | `Test Files 7 passed (7)` / `Tests 174 passed \| 1 skipped (175)` |
| `pnpm build` | `"warnings": []`, `"failures": []` |

Against the stated `origin/main` baseline (root 241 files / 2489 passing + 2
skipped; web 156 / 1182; parity 174 + 1 skipped), root is +5 files and +31
passing tests: 1 file / 9 tests from the parent branch already in review, 2
files / 10 tests from this row's first round, and 2 files / 12 tests added this
round. Web and parity are unchanged. No test was weakened, skipped or deleted,
and no parity baseline moved this round — the baselines recorded in the
previous round still pass byte for byte, which is itself the evidence that the
redesign kept the corpus's lineage coverage.

### Tests changed deliberately (previous round, unchanged here)

`test/exact-kernel-adapter.test.ts`, "removes boolean seams from a unioned
physical part", asserted `Edges are not carried through a boolean`. They are
now, so the assertion was replaced by the exact set of eight edge names the
union keeps (the base plate's four bottom edges and the wall's four top
edges), plus a check that each carries the hash it is published against. The
face assertions in that test are untouched and still pass unchanged.

Parity baselines were re-recorded in the previous round
(`OPENZCAD_WRITE_PARITY_BASELINES=1`, then prettier); the diff is edge names
appearing where there were none. Two `lineageNames` kernel-delta pins moved to
their digest form and two new `witnessedEdges` pins were added with a note
saying what they mean and when they retire (when `occt-lineage.ts` derives the
same subset). Those baselines were **not** touched this round.

## The finding for the kernel owner

`fuseWithEntityEvolution` publishes the **raw fragment layout**, because that
is what its evolution map addresses, where plain `fuse` post-processes its
result. Measured on two stacked 20×20×10 boxes: plain `fuse` 6 faces / 12
edges, `fuseWithEntityEvolution` 10 / 20, which `unifyFaces` only brings to 6 /
16 — four redundant seam edges, i.e. four false edges in the shaded-with-edges
viewport.

That is the smaller half of the finding. The larger half is the table at the
top of this file: **the entity-evolution entry points do not share the plain
ones' exact-only policy, and on curved operands they do not agree with them at
all** — they refuse booleans the plain ones perform, perform booleans the plain
ones refuse, answer a union with one operand, and surface internal
face/edge-id assertions as their error text. Both halves are worth reporting
upstream; fixing them is what would let this row read the payload from the
production call again and retire the second boolean.

## Deliberate limits

- **Two single-solid operands only.** The kernel's entity-evolution entry
  points are pairwise. A union of three bodies keeps the existing `fuseAll`
  reduction, a subtract with several tools keeps the sequential loop, and a
  multi-solid operand keeps its `collapseShape` fuse; all keep carrier lineage
  exactly as before and record the reason. Chaining the evolution across a
  multi-tool subtract is possible — each step would need its own measured
  intermediate — but nothing has proved that chain, and an unproved chain is
  how silent wrongness gets in.
- **The coaxial cylinder cut is untouched.** `tryExactCoaxialCylinderCut`
  takes some cuts through an exact analytic path that publishes no evolution
  record; those keep carrier lineage, and the reason is recorded as a
  diagnostic rather than assumed.
- **Curved-operand booleans get no evolution lineage at all** now, because the
  probe cannot reproduce their shipped body. That is a smaller adoption than
  the previous round claimed, and it is the honest size of it.
- **Edges are `preserved`-only.** `generated` edges could be named by their
  two generating faces, the way fillet blend faces already are. That is a
  coherent next increment and it is **available and untaken** — it is left out
  because a generated edge has no witness relation to verify the claim
  against, and this branch did not want to introduce a naming rule whose only
  evidence is the payload itself.
- **Vertices are decoded away.** The payload carries them; nothing in the
  document addresses a vertex by name.
- **Journaling was not adopted.** `BRIEFING-WAVE2.md` is right that every
  plain call drops a global `unjournaled_mutations` barrier, and this branch
  does not change that: the entity-evolution entry points are not the
  journaled ones. This row buys durable *names*, which is a different
  mechanism from durable *references*; the journal work is its own row and
  should stay one, because it is all-or-nothing per rebuild chain.

## Risks for the reviewer

- **The same-body oracle is face count, face types, edge count and volume.** It
  catches every divergence measured on this pin, with two orders of magnitude
  to spare on the closest one. It would not catch two bodies that agree on all
  four and differ elsewhere — a face swapped for a congruent one somewhere
  else, say. The second line of defence is that every name is still carried by
  exact witness and verified under ADR-013 before it is published, so such a
  body would have to agree face-for-face by witness as well before a wrong name
  could travel. Adding a per-face witness-set comparison to the oracle is
  cheap and would close it entirely; it was left out because it duplicates the
  carry that already happens.
- **The probe costs a second boolean.** Quantified above. It is the cost that
  buys the geometry guarantee.
- **Arena growth.** Each probe leaves two operand copies and a probe result in
  the kernel arena for the life of the rebuild. The adapter already creates
  disposable solids for its guards (`sharedSolidVolume`, the union offset
  suggestion), so this is more of the same rather than something new, but a
  very boolean-heavy document now allocates more than it did.
- **Name growth is a compatibility surface.** Faces and edges that published
  nothing now publish names. Nothing that had a name lost or changed it — the
  name format is unchanged and reconciliation is what guarantees it — but the
  parity corpus's name sets are larger, which is why the baselines moved in the
  previous round.
- **`decodeRemusBooleanEntityEvolution` throws on an unknown edge event.**
  That is intentional fail-closed behaviour, but it means a future kernel that
  adds a fifth event silently drops every boolean back to carrier lineage
  until the decoder learns it. The `declined` reason is recorded as a
  diagnostic so it is visible rather than mysterious.

## Follow-ups

1. **Report both halves of the kernel finding upstream** — the fuse
   post-processing divergence, and the exact-only policy not being applied by
   the entity-evolution entry points. Fixing the second retires the second
   boolean this row now pays for.
2. **Generated-edge naming** by the two generating faces, once there is a way
   to verify such a claim.
3. **Chain the evolution across multi-tool subtracts and multi-body unions**,
   with a measured intermediate per step.
4. **`occt-lineage.ts`** can now retire four parity pins at once by deriving
   the same face and edge subsets.
5. **Fillet and chamfer downstream of a boolean** now have named edges to
   attach to for the first time; an edge modifier pinned by name across an
   upstream boolean edit is newly worth testing.
---

# Parent branch handoff (`claude/remus-kernel-patterns`), unchanged

# Kernel patterns with face provenance

Branch `claude/remus-kernel-patterns`: two commits for the adoption, two
addressing the verifier's minors, plus this file.

## What shipped

The pattern feature used to copy its target with `copyAndTransformSolid` and
hand the copies on with no lineage at all. Every instance face was therefore
hash-only: nothing could say which instance a face belonged to, and a sketch
pinned to the third boss in a row died the moment an upstream edit perturbed
its fingerprint.

It now drives the kernel's own pattern operations, and an instance face
inherits its source face's name with the instance in front of it:

```
pattern.face.instance.2.primitive.box.face.z-max      linear, circular
pattern.face.instance.2-1.primitive.box.face.z-max    grid: column-row
```

The lineage capability for `pattern` moves from `unsupported / hash-only` to
`derived`. A reference on a specific instance now survives a count change: a
sketch on the third block of a four-block row is still on the third block
when the row grows to six.

Geometry is unchanged. The kernel places every instance where the previous
copy-and-transform path placed it — same volumes, same bounding boxes, and,
what actually matters for existing documents, the same ADR-011 face
fingerprints, verified on every instance of a full-turn ring including the
ones that sit off the axes. Stored hash-only references to pattern faces
still resolve.

## Kernel calls adopted

| Adopted | Replaces |
| --- | --- |
| `linearPatternJournaled(solid, dx, dy, dz, spacing, count)` + `getCompoundSolids` + `resolveOperationOutput(op, 'face', i)` | per-instance `copyAndTransformSolid` |
| `circularPattern(solid, ax, ay, az, count)` (full turn only) | per-instance `copyAndTransformSolid` |
| `gridPattern(solid, dirX…, dirY…, spacingX, spacingY, countX, countY)` | the nested copy loop |

One call per source solid, so a multi-solid target patterns each of its solids
and the copies are re-interleaved into the solid order the feature has always
published.

The journal is **candidate evidence, not truth**. `patternJournalFaceClaims`
reads the op's face outputs and checks the layout it is about to rely on —
one block per instance, block zero literally the source solid's own faces in
order, every other block exactly that instance's face set — and returns
nothing rather than trusting a layout it could not confirm.
`deriveRemusPatternInstanceLineage` then publishes a name only where the
source witness carried through that instance's transform matches exactly one
measured face, and refuses with a diagnostic where a journal claim points at a
different face. The existing volume oracle (`sharedSolidVolume` plus the
merge-took check) and the body validity measurement run against the
kernel-produced solids exactly as before.

## Conventions confirmed against the pin, not assumed

Probed with a throwaway node script against the installed `remus-wasm`
(deleted; findings recorded here).

- All three entry points return a **compound handle**, expanded with
  `getCompoundSolids`. The first member is the **source solid handle itself**,
  not a copy — the kernel leaves the seed in place. That matches what this
  feature already did with `[...target.solids]`.
- Direction vectors are **normalized** by the kernel: `(0,0,2)` with spacing 10
  steps 10, not 20.
- `spacing` must be **strictly positive** (`invalid input: spacing must be
  positive, got -5`). This feature accepts a negative spacing, so the sign
  moves onto the direction and the lineage transform keeps the signed value;
  both agree on where instance *i* sits.
- `count` must be >= 1; a zero direction is `cannot normalize zero vector`.
- `circularPattern` spreads `count` copies over **one whole turn**, evenly, about
  an axis **through the world origin**, **right-handed**: a marker at (10, 0)
  with `count` 4 about +z lands at (0, 10), (-10, 0), (0, -10). Negating the
  axis reverses the ring. There is no angle argument, so a partial sweep
  cannot be expressed (see limits).
- `gridPattern` is **row-major**: index `row * columns + column`. This feature
  publishes column-major, so the copies are reordered on the way out and the
  solid order — and every mesh, export and parts list that walks it — is
  unchanged. It refuses parallel directions itself; the product's own check
  stays in front of it so the wording is the product's and applies on the copy
  path too.
- `linearPatternJournaled` returns `{"compound": n, "op": n}` and nothing else.
  The face map is *not* in the payload — it is read back through
  `resolveOperationOutput(op, 'face', index)`, which for a 3-instance pattern
  of a box lists 18 bound face outputs, instance-major, source-face order
  within an instance. Cross-checked independently: setting face names on the
  source and calling `propagateAttributesForOp(op, false)` carries each name to
  the corresponding face of every instance, which is the same relation.
- `circularPattern` and `gridPattern` have **no journaled variant** on this pin.
  Their instances are verified by witness alone, which is the same evidence
  standard the already-`derived` `rigid-transform` row uses.

## Finding: the kernel refuses overlapping patterns

**This is the one real limitation, and it is a kernel limitation, not a
scoping choice.** All three entry points refuse an arrangement whose instances
interpenetrate:

```
pattern instances 0 and 1 overlap by 4e3 model-unit^3
(material-overlap floor 7.009279563550024e-5);
exact instance fusing with face evolution is not yet supported
```

Exactly touching is fine (two 20 mm cubes at spacing 20 pattern happily);
spacing 10 refuses. That refused arrangement is precisely the one
`test/pattern-overlap.test.ts` and `test/overlapping-pattern.test.ts` pin — a
pattern whose instances overlap has to be fused into one solid or every
downstream consumer double-counts the shared material.

So overlapping patterns keep the copy-and-fuse build. The path is chosen
**before** the kernel call, from bounding boxes (`patternInstancesMayOverlap`),
rather than by catching the refusal and matching its message: a box-disjoint
pattern is material-disjoint for certain, so the kernel can never refuse one
on those grounds. The converse is deliberately conservative — instances whose
boxes merely graze take the copy path, which costs a fuse that turns out to be
unnecessary and nothing else.

Both overlapping regressions pass with identical volumes and identical
triangle counts, and the cross-drill render regression passes unchanged.

## A kernel refusal costs evidence, never the body

The kernel arm can throw in two places: an entry point refusing outright, and
`kernelPatternInstanceSolids` rejecting a compound that is not one copy per
instance with the source first. The build loop is not transactional — it
catches per feature, warns, and carries on — so either throw used to delete the
patterned body from the viewport, the parts list and the STEP scope, where the
copy-and-transform path it replaced always produced one.

A refusal now falls back to that copy build:

- the geometry is identical (it is the path that shipped before this branch);
- the instance names are still derived, because the witness check does not
  need the journal — only the journal cross-check is lost;
- the loss is stated as a `pattern-kernel-declined` lineage diagnostic that
  quotes the kernel's own message, so a pattern with no journal evidence
  explains itself instead of going quiet.

Neither throw is reachable on the pinned build from any input I could
construct — the box gate makes an overlap refusal impossible on the kernel
path, and the compound layout is what this kernel returns. It is a latent
robustness gap closed ahead of a kernel bump, and it is covered by two
regressions that spy the kernel into refusing.

## Check results

Run from the worktree root, in order, all green:

```
pnpm lint              ✖ 19 problems (0 errors, 19 warnings)   [baseline: 19 warnings]
pnpm typecheck         (no output; exit 0)
pnpm test              root:  Test Files  242 passed | 2 skipped (244)
                              Tests  2498 passed | 4 skipped (2502)
                       web:   Test Files  156 passed (156)
                              Tests  1182 passed (1182)
pnpm test:parity-corpus       Test Files  7 passed (7)
                              Tests  174 passed | 1 skipped (175)
pnpm build             "warnings": [], "failures": []   (exit 0)
```

The web half matches the briefing's baseline exactly (156 files / 1182 tests).

The root half is **+9 tests over the 2489-test baseline**, and the arithmetic
is worth spelling out because it is not simply "the new file":

- `test/pattern-instance-lineage.test.ts` adds **10** `it`s (8 for the
  adoption, 2 for the refusal fallback below).
- `packages/kernel-adapter/src/topology-lineage.test.ts` changed
  `it.each(['chamfer', 'pattern'])` to `it.each(['chamfer'])`, which removes
  **1** parametrized case. That case asserted `pattern` was hash-only, which
  is no longer true; the sibling test in the same file now asserts
  `topologyLineageCapability('pattern')` equals `{status: 'derived'}`
  explicitly. So one assertion did disappear, and it was replaced by a
  stronger one rather than dropped.

Net **+9**. An earlier draft of this file said "+8 tests, which is the new
regression file" — that was wrong on both halves and is corrected here.

The **4 skipped** root tests against the briefing's stated baseline of 2 are
not this branch: they are `it.skipIf(!sourcePath)` guards in the four
hammer-holder / reconstruction suites that need a local STEP fixture this
machine does not have. This branch adds no skip and removes none.

`pnpm test:e2e`, `pnpm build:desktop` and the `apple-silicon` workflow were not
run, per the briefing.

## The parity corpus DID change — one metric, deliberately

`pattern-boolean-with-import` moves from **6 witnessed faces to 9**, and gains
three lineage names:

```
boolean.face.operand.1.pattern.face.instance.{0,1,2}.primitive.cylinder.face.wall
```

That scenario cuts a three-instance patterned bore tool out of an imported
plate. The three bore walls come from the pattern body, which used to publish
no references for the boolean's carrier rule to inherit; each now carries its
own instance through the cut. The old pin said so in as many words: "the
pattern body … publishes no references at all (pattern lineage is hash-only),
so there is nothing for them to inherit."

Volume, body count, face count, edge count, seam edges, surface types, both
hash digests and the bbox are byte-identical, which is the evidence that only
the naming changed. The baseline and the pin were updated together, by hand
rather than by re-recording, so the diff is exactly those two values plus
their notes. **A reviewer who expected the corpus untouched should read this
as the intended product improvement showing up in the one place the corpus
measures it — but it is a corpus change and it is called out here rather than
buried.**

## Deliberate limits

- **Overlapping instances keep copy-and-fuse and stay hash-only.** The fuse
  rewrites the instance topology and reports no output relation across itself,
  so instance names cannot survive it. The result carries a diagnostic saying
  so rather than going quiet. Unblocking this needs a kernel that can fuse
  pattern instances with face evolution — the refusal message says that work
  is not done.
- **A partial circular sweep keeps copy-and-transform**, because
  `circularPattern` always closes the ring. No capability is lost: its
  instances are rigid copies under a known transform and carry lineage by the
  same check. Only the kernel call is skipped.
- **Edges are not named.** The pin's pattern journal publishes face outputs
  only (`operation N has 0 edge outputs`), and nothing downstream attaches to a
  pattern's edges by name. Face candidates only are measured for instances, so
  a 100-instance pattern does not measure every edge witness to discard it.
- **No schema change.** Nothing new is serialized; a document written before
  this replays identically, and its stored references keep resolving because
  the fingerprints are unchanged.

## Risks for the reviewer

1. **The box gate is a heuristic about which path to take, not about
   correctness.** If it says "may overlap" the result is the previously
   shipped build; if it says disjoint the kernel cannot refuse for overlap. The
   failure mode is a lost opportunity (hash-only lineage on a pattern that was
   actually disjoint), never wrong geometry. Rotated instances use the
   axis-aligned box of the rotated corners, which is larger than the body and
   errs the same way.
2. **Journal layout.** The instance-major / source-face-order layout of
   `resolveOperationOutput` is checked at runtime, not assumed, and a layout
   that does not check out degrades to witness-only verification rather than
   producing a wrong name. But it is read-back behaviour of one pinned kernel
   build and could change under a kernel bump; the check would catch it as a
   silent loss of journal evidence, not as a failure. A kernel bump should
   re-run `test/pattern-instance-lineage.test.ts`. The compound layout is the
   harder half of the same assumption, and under a bump it is the likelier one
   to move — that is now a fallback to the copy build rather than a lost body,
   but it is still a silent loss of evidence, so the diagnostic is the thing to
   grep for after a bump.
3. **Instance numbering semantics.** For a linear or grid pattern an instance
   ordinal is stable under a count change, which is what makes the reference
   survive. For a CIRCULAR pattern the instances move when the count changes
   (the step is `360 / count`), so "instance 2" resolves to the block at a
   different angle. That is the same semantics other parametric CAD uses, but
   it is a judgement call and it is worth a second opinion.
4. **Cost.** Every instance's face witnesses are now measured to verify
   lineage, which the pattern feature never did. Faces only, and the suites did
   not slow measurably, but a 100-instance pattern of a complex body does more
   work than before.

## Verifier round: what changed after review

An independent verifier read the diff and ran the kernel; the verdict was
ready-for-pr with four minors. All four are addressed, none disputed:

1. **Duplicated `PatternInstanceBuild` doc comment.** The same 8-line block
   appeared twice back to back. One copy removed.
2. **`copyShape` was dead.** The pattern builder was its last caller. Removed
   from `exact-shape-utils.ts`; nothing in `packages`, `apps` or `test`
   referenced it.
3. **This file's test arithmetic was wrong.** It claimed +8 and implied nothing
   was removed. The true delta then was +7 (8 added, 1 parametrized case
   removed and replaced by a stronger explicit assertion); with the two new
   fallback regressions it is now +9. Corrected in **Check results** above,
   with the removed case named.
4. **No fallback from a kernel refusal.** Fixed, with two regressions — see
   **A kernel refusal costs evidence, never the body** above.

## Follow-ups

- Overlapping patterns stay hash-only until the kernel can fuse instances with
  face evolution. When it can, the fused branch is the only place to change.
- A partial circular sweep would drop its copy path the day the kernel takes a
  sweep angle; the arm is already isolated behind `circularPatternArm`.
- `propagateAttributesForOp` is a second, independent provenance channel for
  journaled ops (it carried face names across a pattern correctly in probing).
  It mutates face names, so it was not used here, but it is worth knowing about
  for operations where the witness check is weaker than it is for a rigid copy.
