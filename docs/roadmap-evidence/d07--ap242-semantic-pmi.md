---
row: D07
state: Complete
---

Slice D, STEP AP242 semantic PMI
([design](docs/plans/drawing-gdt-design.md#slice-d-step-ap242-semantic-pmi)):
an AP242 File › STEP carries the model's PMI as semantic PMI, each entry on
the exact `ADVANCED_FACE` it applies to. Faces are resolved on the built
solid by lineage, located by the kernel's face order, checked against
surface type, and the export is refused on any mismatch. A datum feature is
a `DATUM_FEATURE` related to its `DATUM`. A frame is its characteristic's
tolerance entity (complex where datum references or modifiers need it),
with its magnitude in the file's length unit, a `DATUM_SYSTEM` of
compartments with Ⓜ/Ⓛ modifiers, and a cylindrical `TOLERANCE_ZONE` for a
Ø zone. With Objects folders, each entry goes on its body's own part
product, and a frame names only datums on that part. Unresolvable entries
are left out, and AP214 files carry none. With this the row's contract is
met:

- datum features and feature control frames on drawing views (slice A);
- general-tolerance blocks and hole and thread tolerance classes (B);
- the same annotations stored on the model (C) and written as AP242 PMI
  (D), all attached through model edits or shown broken.

Evidence: `test/step-pmi.test.ts`:

- on a real export of a box and a pin, datum A on the plane z = 0,
  perpendicularity to A on x = 20, position Ø0.1 Ⓜ to A Ⓜ on the radius-4
  cylinder about x = 40, and flatness on datum A's face, each face read
  back from its own surface geometry;
- every entity reference resolving;
- the inch file's magnitudes in inches, and the AP214 file without PMI;
- a stale face left out;
- with Objects folders, the box's datum and frames on the box's own part
  shape, and the pin's frame naming the box's datum left out;
- a mismatched shell refused, and a `#` inside a solid name ignored.

`test/e2e/step-pmi.spec.ts` makes a datum and a parallelism frame in Objects
and exports them through File › STEP as AP242.
