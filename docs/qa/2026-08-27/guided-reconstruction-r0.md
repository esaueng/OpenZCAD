# Guided reconstruction R0 measurements

Phase R0 adds bounded, test-only STEP probes for analytic surface inventory,
reflection symmetry, and parallel-plane spacing. The proprietary Hammer Holder
STEP remains outside this repository and is supplied only through
`OPENZCAD_HAMMER_HOLDER_STEP`; CI builds and round-trips a synthetic U-bracket
with symmetric countersunk holes and a one-sided emboss surrogate.

## Hammer Holder reproduction

The local witness was measured with the Remus WASM revision pinned by current
`main` (`7918b45d085641b0323ea64b2e66f39ee95260ed`).

| Measurement                       |      Recorded |                        R0 local result |
| --------------------------------- | ------------: | -------------------------------------: |
| Faces                             |           160 |                                    160 |
| Edges                             |           386 |                                    386 |
| Mesh volume at 0.01 mm deflection | 50,240.47 mm³ |                      50,240.482852 mm³ |
| Bounds                            |             — | (-26, 6.5, 4.5) to (48, 59.5, 62.5) mm |
| Parallel inner-face spacing       |         46 mm |                                  46 mm |
| Partial reflection plane          |     X = 11 mm |                              X = 11 mm |

The analytic inventory is 52 planes, 42 cylinders, 2 cones, 8 spheres, 14
tori, and 42 B-spline faces. Of the B-spline faces, eight are the large neck
patches and 34 are text walls. The available local witness validates with zero
errors on the current pin; the earlier plan-of-record note about one strict
orientation error does not reproduce. Geometry counts, census, bounds, and
volume otherwise match the recorded investigation.

Run the local-only case with:

```sh
OPENZCAD_HAMMER_HOLDER_STEP=/absolute/path/to/Hammer\ Holder.step \
  corepack pnpm exec vitest run test/reconstruction-measurement.test.ts
```

The test is skipped when the environment variable is absent, so the file is
never needed by CI or copied into the repository.

## Bounded-work and refusal behavior

The probes return no partial report when a budget or geometry check fails.
Imported solids are limited to 512 faces and 4,096 edges; a face may contribute
at most 512 boundary edges. Reflection analysis is limited to 128 analytic
faces, 2,048 distinct candidate planes, and 32 returned symmetries.
Parallel-plane analysis is limited to 2,048 results. Exceeding any limit throws
a named error instead of silently truncating the measurement.

The edge-sweep diagnostic accepts 3–65 samples per rail and deflections from
0.0001 mm through 1 mm. Edge samples, witness tessellation points/triangles,
and point-to-triangle distance checks each carry explicit caps. Malformed or
over-budget tessellation data is refused before deviation is reported.

## Neck edge-sweep deviation

The experiment selected the only four-sided, large B-spline patch on the left
neck (23.443 mm²). It rebuilt the patch as both possible ruled sweeps between
opposite pairs of its witness boundary edges, retained the better result, and
measured bidirectional point-to-triangle deviation. Rails and the witness were
sampled at 0.005 mm deflection; the ruled candidate used a 65 × 65 grid.

| Direction                  |     Maximum |         RMS |
| -------------------------- | ----------: | ----------: |
| Ruled edge sweep → witness | 0.389399 mm | 0.124148 mm |
| Witness → ruled edge sweep | 1.913926 mm | 0.578596 mm |

This is a sampled diagnostic, not an equivalence proof. It is nevertheless a
clear negative result: even a ruled sweep seeded from the witness's own
boundary edges misses the interior by up to 1.914 mm. Exact-NURBS sketch edges
would not cure that construction mismatch. The neck experiment therefore does
not justify Phase R5; exact-NURBS sketch entities remain deferred unless a
different, independently measured use case establishes their value.
