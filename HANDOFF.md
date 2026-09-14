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
