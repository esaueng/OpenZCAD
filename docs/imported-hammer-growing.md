# Hammer opening with moving arms and mounting holes

This prepared-project construction changes the outside width together with the
opening. It supersedes the fixed-outside-width trimming recipe for this use case;
it does not change existing saved projects or the legacy assistant operation.

The source is cut once at x = -4 and x = 26 mm. The two exact end pieces retain
their arms, lettering, fillets, through holes and countersinks. Their sanitized
STEP payloads are embedded in the prepared project. An ordinary sketch and
extrusion rebuild the measured straight section between them: y = 39.5–59.5,
z = 4.5–12.5, with R3 upper corners. Both ends move symmetrically about x = 11.
The final Boolean joins the ends to the bridge. The original source is untouched.

For opening `w`, outside width is `w + 28` and hole-center spacing is `w - 6`.
Through holes remain Ø5; the larger mounting recesses are Ø9. The expression
`require_min(opening_width, 16.1)` leaves 1.1 mm between those recesses and a
positive 0.1 mm bridge at the minimum. A 10 mm opening would collide even the
through holes. There is no fixed upper limit; non-finite values are rejected and
exact geometry validation still applies. This clearance rule is geometric, not
a structural load rating.

Generate and validate the private project with:

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
viewport-only preview using the cached end meshes and an axially stretched bridge.
The viewport labels it “Width preview · exact geometry pending”. Exact union and
validation continue in the worker; the preview supplies no exact topology and is
never saved as document geometry or passed to exports. Rapid changes are always
computed from the last validated width, and returning to that width restores the
validated display. Invalid widths, structural edits and rebuild failures disable
the preview. Initial project loading still requires an exact rebuild.
