# Handoff — kernel feature recognition for pockets and fillet bands

Branch `claude/remus-feature-recognition`, seven commits on top of `6ada3b3c`
(`origin/main` at the time it was branched). Roadmap row M05; it stays **Partial** — this is read-only
recognition of two families, not the complete imported-feature edit set, and the
ROADMAP row was left unchanged.

## What shipped

An imported body now publishes two families it never published before:

- **Rectangular prismatic pockets**, with their exact depth.
- **Curved fillet bands**, with their exact radius, tangent-contact length and
  material side (`concave` / `convex`).

Both are **read-only**. They carry `provenance: 'kernel-recognized'` in
`RecognizedImportedFeature`, and no coordinated edit operation can bind to one.
Everything the exact kernel-neutral recognizer already published — blind holes,
counterbores, countersinks, bosses, tapers — is unchanged, and the kernel's
answer for those families is now read as a cross-check that must agree.

Authority is fixed per family and written down in
`packages/kernel-adapter/src/remus-feature-recognition.ts`:

| Family | Authority | Kernel's role |
| --- | --- | --- |
| blind hole, counterbore, countersink | exact recognizer | cross-check; must agree |
| boss, taper | exact recognizer | a bore claim over one is a contradiction |
| prismatic pocket, fillet band | kernel recognizer, verified exactly | publishes (read-only) |

A disagreement fails closed: if a kernel hole claim covers an exactly proved
feature and measures a diameter that proof did not publish, **both** answers are
withdrawn, and those faces stay closed to the kernel's families too, so the
contradiction cannot be laundered into a pocket or a band. Kernel *silence* is
not disagreement — its recognizer misses features the exact one proves, and an
unclaimed proof stands unchanged. A payload that cannot be decoded publishes
nothing and cross-checks nothing.

## Kernel calls adopted

`BrepKernel.recognizeFeatures(solid, deflection)` — one call per imported solid,
inside the existing `recognizeImportedFeatures` gate. It replaces nothing: the
exact recognizer still runs first and still owns its families.

### Verified payload shape (probed on the pin, not guessed)

```json
[{"diameter":5.0,"faces":[21],"through":false,"type":"hole"},
 {"floor":45,"type":"pocket","walls":[41,42,43,44]},
 {"area":23.561944901923447,"face":6,"type":"filletLike"},
 {"adjacent":[90,91],"angle":0.7853981633974484,"face":94,"type":"chamfer"}]
```

Face values are handles into the same arena `getSolidFaces` returns. Other
observed types: `chamfer`, and `pattern` in the serde table (never produced in
probing). `chamfer` and `pattern` are skipped; a malformed entry of a type the
adapter DOES consume fails the whole payload closed.

### What probing established about that recognizer

- **A hole claim carries the bore diameter and every wall it attributes to one
  bore.** A counterbore arrives as ONE entry, `{"diameter":5.0,"faces":[55,57]}`
  — diameter 5 is the bore, not the 10 mm counterbore. That is why agreement is
  "matches one of the diameters the exact proof published".
- **Its pocket claim is loose.** On `samples/parametric-bracket.step` it calls
  two open L-slots pockets (one "wall" is a cylinder); on
  `test/fixtures/hammer-holder/synthetic-holder.step` it names the *opening*
  plane as the floor and over-claims two outside walls, and the shell those
  walls really bound is a 0.4 mm **raised pad**, not a pocket; a through slot
  and a slot running off the plate edge are both claimed as pockets.
- **`filletLike` is an area heuristic with no radius and no blend proof.** An
  r0.5 fillet on a 30 mm box edge is claimed; r2 and r5 on the same edge are
  not. It claims the cylindrical bore wall of a countersink, and the conical
  seats on the holder fixture. It claims pocket-corner rounds as fillets AND as
  2 mm holes in the same payload.
- **Deflection did not change any claim** at 0.001, 0.01, 0.1 and 1 on the cases
  probed. The adapter passes `MEASUREMENT_DEFLECTION` (0.08) anyway, so the one
  tessellated quantity involved is measured the way every other adapter
  measurement is.
- `getSurfaceDomain` reports the **untrimmed** cylinder, so a quarter-round band
  reads as a full revolution and its `axialStart/End` are the surface's, not the
  face's. Band length is therefore measured from the straight contact edges.

### Witnesses the adapter requires before publishing

Pocket (`verifyKernelPocketClaim`): the claim is treated as a candidate region
and the shell is re-proved from every planar face it names or touches — planar
floor with straight edges, one wall per floor edge, every wall planar,
perpendicular, four-sided, straight-edged, with exactly two peers and one common
opening plane parallel to the floor, one connected wall cycle, and the opening
on the OUTWARD side of the floor (the witness that separates a pocket from a
pad). A proof counts only when all its walls are named in the claim and the
claim's floor is one of the two planes bounding the shell; two accepted shells
refuse the claim.

Fillet band (`verifyKernelFilletBandClaim`): an exact cylinder running tangent
into two or more planar neighbours — the same tangency witness `isBlendFace`
answers edge modifiers with, refactored out as `tangentPlanarNeighbours` — with
exactly one straight contact edge per tangent wall, all of equal length.

No tessellation samples, traversal order or nearest-geometry guesses are
consumed anywhere in the new code.

## Check results

Run from the worktree root, in order:

```
pnpm lint               ✖ 19 problems (0 errors, 19 warnings)  [pre-existing warnings]
pnpm typecheck          clean (no output)
pnpm test               root: Test Files 243 passed | 2 skipped (245)
                              Tests 2521 passed | 4 skipped (2525)
                        web:  Test Files 156 passed (156)
                              Tests 1182 passed (1182)
pnpm test:parity-corpus Test Files 7 passed (7)
                        Tests 174 passed | 1 skipped (175)
pnpm build              ✓ built; report-bundle-sizes --check
                        "warnings": [], "failures": []
```

The verified `origin/main` baseline is root **241 files passed | 2 skipped,
2489 tests passed | 4 skipped** and web **156 files / 1182 tests**. An earlier
revision of this handoff quoted the root baseline as "242 files / 2516 tests";
that figure was wrong and understated the added coverage. The branch adds
**2 test files and 32 tests**:
`packages/kernel-adapter/src/remus-feature-recognition.test.ts` (25),
`test/imported-kernel-recognized-features.test.ts` (3), and four new cases in
`test/ai-contracts.test.ts`. Web is unchanged, and parity is unchanged.

`pnpm build` now runs here too: it includes `scripts/report-bundle-sizes.mjs
--check`, and the entry chunk is unaffected because nothing new is reachable
from `apps/web/src/App.tsx`. `pnpm test:e2e` and the desktop/apple-silicon
workflows were not run, per the briefing.

Prettier: the two new/edited adapter files were formatted. `exact.ts`,
`exact-brep.ts` and `imported-feature-query.ts` are NOT prettier-clean on
`origin/main` either (verified against the base blobs), so only the new code was
reformatted and no unrelated lines moved.

## What the tests prove

- `packages/kernel-adapter/src/remus-feature-recognition.test.ts`
  - a pocketed plate, exported to STEP and reimported, publishes exactly one
    read-only `prismatic-pocket` of depth 3, and publishes nothing when the
    kernel recognizer is unavailable;
  - a filleted edge publishes a `fillet-band` at r0.5, length 30, convex;
  - the raised pad and the through slot the kernel calls pockets publish
    nothing;
  - **no existing hole proof changed**: for each of the three drilled styles the
    published list is `toEqual` the list produced with the kernel recognizer
    stubbed out, i.e. the pre-change behaviour, and carries no provenance;
  - **an induced disagreement fails closed**: a stubbed 9 mm kernel hole claim
    over the proved 5 mm bore publishes neither answer;
  - all three committed STEP fixtures publish exactly what they published
    before, although each carries kernel claims;
  - **a seed-hash collision is dropped on both code paths**: two identical
    blind bores given one shared face hash publish nothing, whether the kernel
    recognizer answers or is unavailable. This is the regression test for the
    guard fix below; with the fix reverted, the claims-unavailable path
    publishes both features and the two paths diverge;
  - payload decoding and the cross-check are unit-tested directly.
- `test/imported-kernel-recognized-features.test.ts` — a milled pocket survives
  the real document pipeline (primitive → sketch → cut extrude → STEP export →
  import → sync), appears read-only in the published topology and in the AI
  digest, and its faces still carry `opposingPlanarFacePairs`.
- `test/ai-contracts.test.ts` — an edit binds to an exact proof, is refused on a
  read-only one, refused when one seed carries two answers, and still refused
  when the proof is stale or missing.

## Fixes from the verifier round

Two defects were reported against this branch and both are fixed here.

1. **Wrong baseline in this file.** The root-suite `origin/main` baseline was
   quoted as "242 files / 2516 tests". The measured baseline is 241 files
   passed / 2489 tests passed (2 skipped files, 4 skipped tests), so the branch
   adds 2 files and 32 tests, not 1 and 4. The Check results section above now
   carries the measured numbers and says so plainly.

2. **`collectRecognizedImportedFeatures` skipped the seed-ambiguity guard on
   one path.** When the kernel recognizer was unavailable or its payload could
   not be decoded, the function returned early at the `if (!claims)` branch
   *before* `withoutAmbiguousSeeds`, while the normal path applied it. Both
   outcomes fail closed (the guard's purpose is to drop an ambiguous pair, and
   downstream binding throws on the pair that leaks), so no wrong geometry was
   reachable — but the two paths disagreed, and the fixture test
   `expect(recognize(solid)).toEqual(recognize(solid, withKernelClaims()))` is
   exactly the equality that would have stopped holding. The early return now
   applies the same guard, and the new collision test pins both paths to the
   same answer.

## Deliberate limits

- **Read-only, by construction.** No coordinated edit operation was added for
  either family, and `exactDigestImportedFeature` refuses a read-only feature by
  name so a future operation kind cannot silently acquire one.
- **The exact recognizer was not touched.** Its pocket path still requires an
  exact straight-edge loop and still publishes nothing from a live solid. I did
  not add polygon publication to the query: that would have made ZCAD the
  authority for pockets, which is the opposite of this task.
- **Pockets: one closed four-sided-wall cycle only.** A pocket whose floor has a
  second loop (a hole in the floor), whose corners are filleted (the fillet
  cylinders are in the wall cycle), or that runs off an edge is refused. An
  L-shaped pocket is refused by the kernel's own claim shape before we see it.
- **Bands: cylinders only.** A torus or NURBS blend (a fillet along a curved
  edge, a corner patch) has no exact radius in this contract and is refused.
- **A kernel hole claim is never published**, even where the exact recognizer
  proves nothing — a through hole, for instance. That family has one authority.
- **Committed STEP fixtures gained no features.** None of the three contains a
  rectangular pocket that survives its witness: the bracket's are open slots and
  the holder's is a raised pad. The pocket evidence is therefore a milled fixture
  round-tripped through STEP, in the style the other imported-feature tests use.

## Risks for the reviewer

- **Pocket seeding.** Because the kernel mislabels floors, the verifier re-proves
  shells from the claim's faces *and their neighbours* (bounded at 256 seeds).
  The subset-of-claimed-walls and floor-anchoring conditions tie the result to
  the claim, but this is the loosest joint in the change; it is where a
  disagreeing reviewer should look first.
- **The material-side witness is a single test** (opening plane on the outward
  side of the floor). It correctly refuses the holder's pad and accepts every
  milled pocket probed, and it does not assume a convex floor — but it is the
  only thing separating a pocket from a pad.
- **Cost.** One extra kernel call per imported solid, plus a bounded B-Rep walk
  per claim, inside the existing recognition stage. Not benchmarked on a large
  import; the hammer-holder fixtures recognize in the same test-suite time as
  before.
- **Diameter agreement tolerance** is `1e-9` relative with a floor of 1. Both
  recognizers read the same analytic radius, so the observed difference is zero;
  a STEP import that reconstructs a radius differently in the two paths would
  read as a contradiction and withdraw a hole proof. That is the fail-closed
  direction, but it is a way this change could cost a feature.
- **Digest ordering changed**: read-only features sort after editable ones inside
  the per-body cap. Nothing binds to order, and the auto-parameterize hole index
  only counts hole kinds, but it is a visible change in what the model sees.

## Concurrent main (read before merging)

`origin/main` advanced while this branch was in flight — first to `aafdf35b`
(#328, shared measured editing workflow for imported parts) and, as of this
round, to `d12b0281` (#327). This branch is based on `6ada3b3c`, and
`git merge-tree --write-tree HEAD origin/main` merges **cleanly** against both
(no conflicted paths), although #328 and this change both touch
`packages/shared/src/index.ts`, `packages/ai-contracts/src/index.ts`,
`auto-parameterize.ts` and `packages/kernel-adapter/src/exact.ts`. Re-run all
five checks after the merge.

Semantic interaction checked: #328's `edit-candidates.ts` reads
`recognizedImportedFeatures` for its `measuredOnly` list and switches
explicitly on the three hole kinds, returning `[]` for anything else — so a
read-only pocket or fillet band produces no edit candidate and no measured-only
row. That is correct but silent; surfacing them there with a "recognized by the
kernel, read-only" reason is a natural follow-up.

## Follow-ups

- Publish an exact straight-edge loop from the live query so the exact
  recognizer can prove pockets itself; then the two recognizers can be run
  against each other on pockets the way they now are on holes, and a pocket
  could become editable.
- Coordinated edit operations for pockets (depth, width) and bands (radius) —
  each needs a replayable proof, which is exactly what this change does not
  create.
- Torus/NURBS fillet bands, and pockets with filleted corners: both are common
  in imported parts and both are refused today.
- The kernel's `chamfer` claim family is decoded-and-skipped; adopting it would
  follow this same shape (verify tangency/angle exactly, publish read-only).
