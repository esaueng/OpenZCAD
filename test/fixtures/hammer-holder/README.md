# Native Hammer Holder diagnostic fixture

This is a reconstruction of the September 5, 2026 native modeling attempt,
not an export of its browser document or a model imported from the reference
STEP. `native-document.ts` creates ordinary current-schema documents through
document-core. Feature, body, sketch and object IDs are stable; project container
IDs and creation timestamps are freshly generated. The regression serializes
and normalizes each stage before rebuilding it. Call
`JSON.stringify(createNativeHolderStages(), null, 2)` to retain all intermediate
canonical documents without browser-local state.

Recorded application baseline: `1514dbc0fb3a73bffbf38aa53405603311aaad2e`.
Reproduced on application starting commit `152ae6d7` with the frozen Remus WASM
consumer `c557ef5b37544cb451d9d24c8b9ce68e8c8bb39c` (2.130.0). No dependency,
unit, tolerance, schema or kernel API changes are involved.

## Geometry and differences from the recorded UI

Millimetres; source axes preserved; source origin translated by
`(-11, -49.5, -4.5)`. The 74 × 53 × 8 plate is cut by a 46 × 33 rectangle,
then receives two 14 mm arm extrusions at X = 23 and X = -37. The closed
line/quarter-arc profile has a 15 mm outer hook and reaches Z = 58.

The opening uses the equivalent world XY rectangle at Z = 8 swept -8. The
recorded UI used rotated face-local axes on the generated top face; its exact
persisted attachment/reference and intermediate document were unavailable.
Both arms use the documented canonical YZ planes. The second arm uses the
corrected final coordinates, omitting the transient 1 mm drawing error.

The fixture uses region-based extrusion, as the UI does. It omits unattached
bore-layout sketches, attempted Add extrusions, lettering and freeform neck
transitions. Dynamic edge/face picks use geometric witnesses rather than
recorded hash values. The Hole retry uses the remaining 420 mm² plate face,
at U/V = 0 after the successful right plate-edge fillet; it is a capability
probe, not the precisely located pair of mounting holes.

## Current observations, not support claims

Current regression pin: Remus `f19685684714003255f9a98e8e6a885d1419e5dd`
(2.130.14, on Remus `main`). Earlier raw-kernel probes below describe the historical consumer
and have not all been repeated on this pin.

Run `pnpm exec vitest run test/hammer-holder-native.test.ts`.

| Stage          | Faces | Strict errors | Relaxed errors | Detailed strict diagnostic |
| -------------- | ----: | ------------: | -------------: | -------------------------- |
| Plate          |     6 |             0 |              0 | None                       |
| Opening cut -8 |    10 |             0 |              0 | None                       |
| First arm Add  |    17 |             0 |              0 | None                       |
| Second arm Add |    24 |             0 |              0 | None                       |

All four stages have one shell and no build warnings, and every stage now
passes strict validation. Until the sweep-direction fix in
`exact-profile-builders.ts` (`forwardSweep`), the opening cut swept its
profile −8 against the plane normal and built an inside-out shell: the
opening, first-arm and second-arm stages reported 8, 6 and 4 "shared edges
have inconsistent face orientations" while every independently tessellated
mesh had zero boundary, non-manifold or inconsistent-winding edges, and the
arm stages carried 21 and 34 faces because face unification refused the
mis-oriented candidates. The historical table is kept in git history; the
diagnosis was that the wire winding relative to the sweep displacement
decides orientation, not the sign of the distance — a negative span is now
built on the far plane and swept forward.

The plate and opening volumes have analytic rectangular oracles. Curved-stage
volume values in the test are measured witnesses, not exact truth: the native
UI and this reconstruction agree at 52318.9434704 mm³ for the two-arm blank.

Both standalone opening tools (negative and positive sweeps) pass strict
validation, and the negative-opening path now matches the positive-opening
path in bounds, volume, face count and strict validity.

The tests also reproduce and guard recovery at these refusal boundaries:

- Mirror of the first arm succeeds now that the input is a valid closed solid.
- The 35 mm outer arm edge refuses fillets at both 3 and 1 mm; input survives.
- The 30 mm top plate edge under the arm foot (z = 8) refuses a 3 mm fillet on
  the valid body (the inside-out body used to accept a fragment of it); the
  30 mm bottom plate edge (z = 0) accepts it (24 → 25 faces).
- Both 5 mm Simple and 5/9 mm, 90° countersunk through-hole cuts succeed on
  the filleted body's unified 1760 mm² top face (25 → 27 and 28 faces); on the
  inside-out body both used to fail and retain their target.

These are explicit diagnostic characterization tests, with no `test.fails`.
They do not mark M1 complete. A kernel repair should advance the assertions to
valid native operations, rather than relaxing validation to preserve failures.

## Ownership and next investigation

`validateSolidDetailed` returns a JSON report from the strict validator.
`exact.ts` measures ordinary extrusions with `validateSolidRelaxed`; its strict
publication check is restricted to explicit Boolean Union features. Extrude
Add/Cut therefore do not use the same validation contract as Mirror's strict
`snapshotSolid` in `remus-modeling-operations.ts`. Hole validates its cut result
in `exact-cylinder-ops.ts`. A successful render/mesh does not resolve that gap.

The H3 two-circle bore inference is also reproduced through the real
`resolveExtrudeOperation` and adapter. Both 2.5 mm radius cylinders are inside
the bridge, centred at (-20, 0) and (20, 0), swept -8 from Z = 8. Measured:

| Measurement            |                  mm³ |
| ---------------------- | -------------------: |
| Two-cylinder tool      |    314.1592653589793 |
| Filleted target        |   52260.790324680485 |
| Add preview            |    52262.06593352123 |
| Inferred common volume |   312.88365651822824 |
| Classifier tolerance   | 0.052260790324680485 |

The measured union is 1.275608840745 mm³ larger than the target despite full
containment, exceeding the classifier tolerance. Automatic inference therefore
selects Add / partial-overlap with the correct target after two derive passes,
with no warnings. This explains the observed classification on the reconstruction;
it does not establish whether the discrepancy is in volume integration or the
boolean geometry. Increasing tolerance globally is not justified. The fixed-plane
face-sketch retry and original browser inference data remain unavailable.

An additional diagnostic probe of this same pinned WASM consumer intercepted raw
Cut, Fuse and unification calls. The negative raw Cut already has eight bad
shared-edge senses; unification leaves it unchanged. Raw first-arm Fuse has ten
bad senses after the negative opening and six after the positive opening.
Unification worsens those to fifteen and eleven respectively; the application's
safe-unify path correctly discards the worse candidate.

Serialized planar wires isolate two subsequent native regression targets:

- The negative rectangular cutter's six stored outer-wire windings oppose
  their stored surface normals; the positive cutter's align. Both pass the
  operations validator, which omits the outer-wire/surface orientation check.
  At the pinned source, inspect `crates/operations/src/extrude.rs:1080` and
  `crates/check/src/validate/face.rs:23`. Test both profile windings and both
  sweep directions, including the subsequent Cut, before changing emission.
- On the strictly valid positive-opening path, the arm's planar wires align,
  but all six bad raw Fuse edges touch split portions of the existing reversed
  opening wall at X = 23. Investigate reversed-plane splitting/assembly.
  `crates/operations/src/boolean/mod.rs:4391` documents this sensitivity and
  contains a narrowly used normalization helper; it is not evidence that
  applying normalization globally is safe.

These external diagnostic observations guide the next kernel regression; they
are not additional passing feature tests. Do not bypass strict validation or
claim that a direction reversal fixes all failures. Native Rust comparison,
actual browser-document export, original H3 inference state, exact hole
positioning and final STEP round-trip remain gaps.

## Synthetic holder STEP fixtures

`synthetic-holder.step` (Ø5 countersunk bores) and `synthetic-holder-open.step`
(no bores) are the kernel's own export of `test/support/synthetic-holder.ts`.
`test/synthetic-holder-fixtures.test.ts` fails when they drift from the
builder; regenerate with `OPENZCAD_WRITE_HOLDER_FIXTURES=1` on that test.
`test/e2e/growing-holder.spec.ts` drives the fresh-import-to-export
walkthrough of the growing-holder plan on them, so the private hammer never
enters CI.
