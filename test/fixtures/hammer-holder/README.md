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

Run `pnpm exec vitest run test/hammer-holder-native.test.ts`.

| Stage          | Faces | Strict errors | Relaxed errors | Detailed strict diagnostic                          |
| -------------- | ----: | ------------: | -------------: | --------------------------------------------------- |
| Plate          |     6 |             0 |              0 | None                                                |
| Opening cut -8 |    10 |             1 |              0 | 8 shared edges have inconsistent face orientations  |
| First arm Add  |    21 |             1 |              0 | 10 shared edges have inconsistent face orientations |
| Second arm Add |    34 |             1 |              0 | 12 shared edges have inconsistent face orientations |

All four stages have one shell and no build warnings. Independently tessellated
at 0.08 mm, all have zero boundary, non-manifold or inconsistent-winding mesh
edges. This does **not** establish valid exact B-Rep orientation. The diagnostic
is not evidence of an open mesh, and whether the defect is in the representation
or its strict validator remains unresolved.

The plate and opening volumes have analytic rectangular oracles. Curved-stage
volume values in the test are measured witnesses, not exact truth: the native
UI and this reconstruction agree at 52318.9434704 mm³ for the two-arm blank.

Both standalone opening tools (negative and positive sweeps) pass strict
validation, so the earliest orientation failure is introduced by the Cut.
A controlled equivalent opening swept +8 from Z = 0 has strict error count zero
and the same bounds, face count and volume. That isolates a direction-dependent
opening defect. It does not repair the whole holder: adding the first arm still
introduces six inconsistent-orientation edges, and the second arm reports 12.

The tests also reproduce and guard recovery at these refusal boundaries:

- Mirror rejects the first-arm **input** and leaves it available.
- The 35 mm outer arm edge refuses fillets at both 3 and 1 mm; input survives.
- The 30 mm plate edge accepts a 3 mm fillet (34 → 36 faces).
- Both 5 mm Simple and 5/9 mm, 90° countersunk through-hole cuts fail after that
  fillet and retain their target body.

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

Next isolate negative sweep cutting and the subsequent arm union in
Remus with input/output detailed reports and face/wire orientation metadata.
Do not bypass strict validation or claim that a direction reversal fixes all
failures. Native kernel comparison, actual browser-document export, original H3 inference state,
exact hole positioning and final STEP round-trip are still gaps.
