# Hammer opening with moving arms and mounting holes

This prepared-project construction changes the outside width together with the
opening. It supersedes the fixed-outside-width trimming recipe for this use case;
it does not change existing saved projects or the legacy assistant operation.

The construction is compiled from a measured recipe by
`growingHolderCommand` in `packages/command-system/src/growing-holder.ts`. A
`GrowingHolderRecipe` names the imported body, the opening axis, the source
envelope, the two cut coordinates (x = -4 and x = 26 mm here), the symmetry
center (x = 11), the measured opening (46), the parameter, the minimum opening
and the section profile (y = 39.5–59.5, z = 4.5–12.5 with R3 upper corners).
Nothing is inferred: the recipe is produced by measurement or, until
recognition exists, written by hand.

The compiler emits ordinary history. Each end is the exact intersection of the
source with a box mask outside its cut plane — the positive end from a second
reference to the same import, because a Boolean consumes its operands and the
kernel's plane split cannot cross the section's cylindrical corners. The two
ends retain their arms, lettering, fillets, through holes and countersinks. An
ordinary sketch and extrusion rebuild the straight section at the parametric
length; both ends move symmetrically about the center; the final union joins
them. The end carving reads no parameter, so its rebuild checkpoints survive
every opening edit (`readsParameterScope` in the history cache); only the
bridge, the two moves and the union rebuild. No STEP payload is re-cut by
hand. When the import is a content-addressed source reference the second
reference shares its bytes; an embedded `stepText` import is copied.

`recognizeOpening` in `packages/kernel-adapter/src/opening-recognition.ts`
measures that recipe from the exact solid. It pairs planar faces that look at
each other along a world axis and proves the gap between them empty, confirms
the center with a reflection plane, finds the longest run between the inner
faces over which the set of crossing faces is constant and every one of them
is invariant along the axis (planes parallel to it, cylinders along it), and
then proves the run by intersecting the solid with a slab between the cuts:
one planar end face at each cut, identical exact profiles on both, nothing
else that is not straight. On the hammer it returns exactly the hand-authored
recipe: cuts at -4 and 26, center 11, opening 46, minimum 16.1 and the
six-object section. Two equal openings are reported as ambiguous with their
candidate face pairs for a guided selection; a solid with no facing pair, no
confirming symmetry, no straight run, a hollow or curved-edged section is
refused with the reason. The kernel's `section` query is deliberately not
used: on NURBS-bearing solids it reports silhouettes, not cross-sections.

The kernel adapter runs `recognizeOpening` for every live single-solid
imported body during the exact sync and publishes the result as
`topology.recognizedOpening`, so the assistant digest carries either the
measured recipe or the reason there is none. The assistant operation
`add_growing_holder_recipe` names the target body and the parameter and
copies that `opening` verbatim; `validateCadPatchProposalAgainstDigest`
refuses any value that is not byte-identical to the digest's measurement, the
same binding direct edits have to their imported-feature proofs. The app also
offers the measured recipe as the verified suggestion "Parameterize the
opening" (`createGrowingHolderProposal`), which bypasses the provider and
passes the same exact preflight before it can be applied as one undoable
transaction. For assistant-authored proposals the operation is rollout-gated
by `AI_PATCH_GROWING_HOLDER_ENABLED`; the verified suggestion needs no flag.
New proposals use this operation; `add_imported_opening_recipe` remains only
for the older fixed-outside-width recipe.

The union feature carries the recipe as JSON under the
`openzcad.growingHolderRecipe` metadata key. `growingHolderHistories` reads it
back and verifies every implied feature against what the compiler emits; a
history edited by hand is not claimed, so nothing downstream assumes its
geometry.

For opening `w`, outside width is `w + 28` and hole-center spacing is `w - 6`.
Through holes remain Ø5; the larger mounting recesses are Ø9. The expression
`require_min(opening_width, 16.1)` leaves 1.1 mm between those recesses and a
positive 0.1 mm bridge at the minimum. A 10 mm opening would collide even the
through holes. There is no fixed upper limit; non-finite values are rejected and
exact geometry validation still applies. This clearance rule is geometric, not
a structural load rating.

A redistributable synthetic U-bracket exercises the same construction in CI
(`test/growing-holder-recipe.test.ts`) in its source orientation and rotated
so the opening runs along y and along z. Generate and validate the private
project with:

```sh
OPENZCAD_HAMMER_STEP="$HAMMER_STEP" OPENZCAD_HAMMER_WIDTH=55 \
  OPENZCAD_HAMMER_OUTPUT=/tmp/hammer-growing-55.openzcad \
  pnpm exec vitest run test/hammer-holder-growing.test.ts
```

The opt-in test checks strict solid validity, expected bounds and hole positions,
closed tessellation, STEP round-trip, and backup parsing. It verifies the replaced
source section against its exact analytic volume and surfaces. Whole-holder
volume uses tessellation for NURBS surfaces and is not an exact identity oracle
across different face partitions. Source payloads and generated backups stay outside
Git. Automatic recognition and preparation from an arbitrary imported STEP are
not implemented by this fixture-specific generator.

After the first successful exact rebuild, changing `opening_width` displays a
viewport-only preview using the cached end meshes and an axially stretched
bridge. The preview finds the recipe through `growingHolderHistories`, so it
follows the recipe's axis, cuts and minimum instead of a fixed feature shape.
The viewport labels it “Width preview · exact geometry pending”. Exact union and
validation continue in the worker; the preview supplies no exact topology and is
never saved as document geometry or passed to exports. Rapid changes are always
computed from the last validated width, and returning to that width restores the
validated display. Invalid widths, structural edits and rebuild failures disable
the preview. Initial project loading still requires an exact rebuild.
