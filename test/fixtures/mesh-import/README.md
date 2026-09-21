# Mesh import parity fixtures

These are small, synthetic, redistributable fixtures for F04. Each file
describes the same closed box in its format's native coordinate convention:
eight vertices, twelve outward-facing triangles, bounds `(0, 0, 0)` to
`(2, 3, 4)`, and volume `24` in the format's adopted units.

The OBJ and PLY files are readable text. The GLB and 3MF packages are stored as
base64 text so the repository stays source-only and reviewable; the test
helper decodes them before handing bytes to the production import path. The
translated 3MF places the same box at `x = 7` through its `<build>` transform.

These files are independent of `test/support/mesh-import-fixtures.ts`. The
support builders remain useful for unit, placement, malformed-input, and
budget variants, while these files exercise the actual reader against a
committed format payload.
