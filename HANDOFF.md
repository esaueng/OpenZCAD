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

A two-operand boolean now runs through the kernel's own entity-evolution
entry points, which name the operand face **every** result face came from.
Both boss caps keep their identity, the sketch resolves by name, and the
warning is gone.

Edges came with it, and were worth taking. The payload marks every result edge
`preserved` / `modified` / `generated` / `unresolved`. A `preserved` edge whose
exact witness is unchanged now keeps its operand's name:

```
boolean.face.target.primitive.box.face.z-max          (unchanged form)
boolean.edge.operand.0.primitive.box.edge.x.y-min.z-min   (new)
```

Measured on the parity corpus, an imported plate bored by a cylinder went from
**0 to 12** named edges, and the NURBS-cornered plate from 0 to 16 — with its
face names unchanged, because the carrier rule had already named all of those.

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
- **Booleans of more than two solids** — see Deliberate limits.

## Kernel calls adopted

| call | replaces | where |
| --- | --- | --- |
| `cutWithEntityEvolution(a,b)` | `kernel.cut(a,b)` | cut extrude; 2-operand subtract |
| `intersectWithEntityEvolution(a,b)` | `kernel.intersect(a,b)` | 2-operand intersect |
| `fuseWithEntityEvolution(a,b)` | `fuseAll([a,b])` inside `fuseUniformSolid` | add extrude; 2-solid union |

These are the **production** calls, not a second boolean taken for evidence: a
boolean is the expensive operation in a rebuild, and paying for two on every
feature to learn where the faces came from is not a trade worth making.

Decoding goes through the repo's own lineage machinery, as
`KERNEL-FINDINGS.md` requires — there is no `decodeEvolutionPayload` on the
pin. New in `remus-lineage.ts`:

- `decodeRemusBooleanEntityEvolution` — strict decoder. Every malformed
  payload throws, including an edge event the pin does not publish: a kernel
  that grows a fifth event must make the caller decline the whole record, not
  quietly drop what it does not understand.
- `deriveRemusBooleanEvolutionLineage` — the derivation and its three gates.
- `reconcileRemusBooleanLineage` — see below.
- `carryRemusUnchangedLineage` — extracted from
  `propagateRemusUnchangedDirectEditLineage` (which now delegates to it,
  unchanged) so the boolean can carry lineage across its unification step by
  exact witness.

New file `exact-boolean-evolution.ts` holds the kernel-call side.

## The architectural rule, as implemented

**Kernel history is candidate evidence; witnesses verify.** Nothing here takes
the kernel's word.

1. **The payload must partition the measured result.** The reported result
   faces must be exactly the measured result faces, and every source must be a
   measured operand face. A payload that is not is refused *whole* — never
   consumed in part.
2. **The operand reference re-verifies** against the operand's own measured
   witness, so a reference the operand's own build had already invalidated
   cannot travel through the boolean.
3. **The transition satisfies the ADR-013 witness relation.** Every face claim
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

## The finding: the fuse entry point is not the fuse

`fuseWithEntityEvolution` publishes the **raw fragment layout**, because that
is what its evolution map addresses. Plain `fuse` post-processes its result.
Measured on the pin, two stacked 20×20×10 boxes:

| call | faces | edges |
| --- | --- | --- |
| `fuse(a,b)` | 6 | 12 |
| `fuseWithOptions(a,b,false)` | 6 | 12 |
| `fuseWithEntityEvolution(a,b)` | 10 | 20 |
| ...then `unifyFaces` | 6 | **16** |

Four redundant seam edges the plain path never had — four false edges in the
shaded-with-edges viewport, which is exactly the defect `unifyBooleanFaces`
exists to prevent. `cutWithEntityEvolution` and `intersectWithEntityEvolution`
showed **no** such divergence on any fixture tried (through hole, blind pocket,
slot across, flush half, stepped notch, coincident boxes, cylinder through a
plate, identical boxes).

So the fuse arm is guarded. Where unification had to merge anything, the plain
`fuseAll` is run on the operands (which survive the first call — measured) and
the two bodies are compared by face types, edge count and volume; the
evolution body ships only when it is the same body, and otherwise the plain
body ships and the boolean falls back to carrier lineage. Where unification
merged nothing — a boss grown onto a plate, the case this row exists for — no
second fuse runs at all.

`test/boolean-evolution-lineage.test.ts` pins this: with the guard removed the
stacked union ships 16 edges instead of 12.

**This is a finding for the kernel owner**, not something papered over: the
entity-evolution fuse and the plain fuse do not agree on the same input. It
would be better fixed in Remus by giving the evolution entry point the same
post-processing, with the evolution map rewritten across it.

## Check results

Run from the worktree root on the final tree.

| check | result |
| --- | --- |
| `pnpm lint` | `✖ 19 problems (0 errors, 19 warnings)` — the 19 pre-existing warnings |
| `pnpm typecheck` | clean, no output |
| `pnpm test` (root) | `Test Files 244 passed \| 2 skipped (246)` / `Tests 2508 passed \| 4 skipped (2512)` |
| `pnpm test` (web) | `Test Files 156 passed (156)` / `Tests 1182 passed (1182)` |
| `pnpm test:parity-corpus` | `Test Files 7 passed (7)` / `Tests 174 passed \| 1 skipped (175)` |
| `pnpm build` | `"warnings": []`, `"failures": []` |

Against the stated `origin/main` baseline (root 241 files / 2489 passing + 2
skipped; web 156 / 1182; parity 174 + 1 skipped), root is +3 files and +19
passing tests. This branch's two new suites account for 2 files and 10 tests,
measured on their own; the remaining 1 file, 9 tests and 2 extra skips come
from the parent branch already in review. Web and parity are unchanged. No
test was weakened, skipped or deleted.

### Tests changed deliberately

`test/exact-kernel-adapter.test.ts`, "removes boolean seams from a unioned
physical part", asserted `Edges are not carried through a boolean`. They are
now, so the assertion was replaced by the exact set of eight edge names the
union keeps (the base plate's four bottom edges and the wall's four top
edges), plus a check that each carries the hash it is published against. The
face assertions in that test are untouched and still pass unchanged.

Parity baselines were re-recorded (`OPENZCAD_WRITE_PARITY_BASELINES=1`, then
prettier); the diff is edge names appearing where there were none. Two
`lineageNames` kernel-delta pins moved to their digest form and two new
`witnessedEdges` pins were added with a note saying what they mean and when
they retire (when `occt-lineage.ts` derives the same subset).

## Deliberate limits

- **Two operands only.** The kernel's entity-evolution entry points are
  pairwise. A union of three bodies keeps the existing `fuseAll` reduction and
  a subtract with several tools keeps the sequential loop; both keep carrier
  lineage exactly as before. Chaining the evolution across a multi-tool
  subtract is possible — each step would need its own measured intermediate —
  but nothing has proved that chain, and an unproved chain is how silent
  wrongness gets in.
- **The coaxial cylinder cut is untouched.** `tryExactCoaxialCylinderCut`
  takes some cuts through an exact analytic path that publishes no evolution
  record; those keep carrier lineage, and the reason is recorded as a
  diagnostic rather than assumed.
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

- **The fuse guard's trigger.** It fires when unification changed the face
  count, which is the condition under which the divergence above was observed.
  A fuse where plain `fuse` simplifies *edges only* — no face merge — would
  slip past it and ship the evolution body with extra edges. I could not
  construct such a case, but I cannot prove it does not exist. The airtight
  alternative is running both fuses on every union, which doubles the cost of
  the most expensive operation in a rebuild; that trade seemed wrong.
- **One extra topology measurement per boolean, in the union case.** Lineage
  is derived against the raw pre-unification result, because that is what the
  payload addresses. Where unification leaves every handle in place — the cut
  case, usually — those same candidates are reused as the result's and the
  cost is nil. Where it does not — `unifyUnionFaces` hands back a copy when it
  accepts — the post-unification body is measured as well. Full-suite wall
  time did not move noticeably, but this is worth a look if rebuild timings
  regress.
- **Name growth is a compatibility surface.** Faces and edges that published
  nothing now publish names. Nothing that had a name lost or changed it — the
  name format is unchanged and reconciliation is what guarantees it — but the
  parity corpus's name sets are larger, which is why the baselines moved.
- **`decodeRemusBooleanEntityEvolution` throws on an unknown edge event.**
  That is intentional fail-closed behaviour, but it means a future kernel that
  adds a fifth event silently drops every boolean back to carrier lineage
  until the decoder learns it. The `declined` reason is recorded as a
  diagnostic so it is visible rather than mysterious.

## Follow-ups

1. **Report the fuse post-processing divergence upstream** so the evolution
   entry point can share plain `fuse`'s post-processing; that retires the
   guard and the second fuse with it.
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
