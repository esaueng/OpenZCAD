# Curved NURBS trim rendering

The non-planar CDT mesher seeded cylindrical and conical faces with only two
axial rows. A curved NURBS trim could lie entirely between those rows, leaving
boundary triangles to bridge the trim valley with long inward chords. The exact
surface and STEP topology were unchanged; the visible wall was wrong.

[Remus PR #523](https://github.com/esaueng/remus/pull/523), shipped in packages
2.130.29 at `62bf14725585dc869d41fc64822ef1f339dcb09c`, extends the existing ellipse-trim refinement to NURBS trims on
cylinders/cones. It adds samples only over the trim's axial range, keeps existing
resource limits and boundary clearance, and reuses shared boundary vertices.
Level NURBS rims and straight seams retain their existing treatment.

## Public regression

`test/fixtures/step/nurbs-trimmed-cylinder.step` is an independently constructed
half-cylinder with radius 4 mm, top at z=10 mm and bottom at z=x/4. Its lower
rim is an exact rational quadratic NURBS curve. The fixture was generated from
Remus's `nurbs_trimmed_cylinder_sector` regression helper, not from a user model.
Its closed-form volume is `80*pi - 32/3` cubic millimeters.

`test/step-nurbs-trimmed-cylinder.test.ts` checks the app's imported display mesh
against the cylinder at triangle centroids and edge midpoints. The old pin
missed the surface by 0.02818 mm against the 0.002 mm display budget. The test
also checks source-text preservation, the analytic volume and exact STEP
export/reimport with cylindrical and NURBS entities retained.

The native regression runs at 0.1x, 1x and 10x scale, checks the same chord bound
and requires every shared mesh edge to have exactly two incident triangles.
The regression fails on the original mesher.

## Local private-file validation

The supplied saved project contains one STEP-import feature. Its embedded
source's SHA-256 matches the separately supplied STEP. The complete saved
history was rebuilt with its source resolver and exported/reimported as a valid
exact solid model. The display error on the affected wall is within the app's
size-derived tolerance. Tessellating the imported arena leaves its serialized
exact geometry byte-identical.

The original defect and the corrected saved project were inspected in the
local browser. Private source files and screenshots are not included in this
repository. This is local evidence, not a production deployment claim.

## Validation

Local OpenZCAD lint, typecheck, unit suites (2,895 root and 1,311 web tests),
parity corpus (174 passed, one existing skip) and the full build with bundle-size
checks passed. The public synthetic regression and the private saved-document
check passed. The installed GitHub package WASM hashes match the locally tested
build. Browser-suite and hosted CI status are recorded in the adoption PR.

Upstream validation includes 1,113 operations tests, five STEP blend-preservation
tests, clippy, formatting, boundary/hash checks, and the complete optimized WASM
build with runtime and installed-tarball consumer checks.
