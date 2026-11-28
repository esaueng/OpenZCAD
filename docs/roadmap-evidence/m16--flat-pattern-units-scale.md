---
row: M16
---

Flat-pattern exports now match the folded part's units and size. The DXF
writer converts its line-type dash, gap and cycle lengths (DASHED 0.5/0.25 mm,
HIDDEN, CENTER) from millimetres into the declared `$INSUNITS`, so inch, cm and
m bend lines dash at the same physical length as mm ones
(`test/dxf-writer.test.ts`; `test/sheet-metal-flat-pattern.test.ts` parses
mm, cm and inch flat DXFs of the same physical L bracket and compares their
outline, bend line and dashes in mm). Later in-place Scale features on the
sheet's body are applied to the pattern (outline, bend lines and notes,
thickness, inside radii, allowances, deductions; angles and K-factors stay),
listed as `scaledBy` and labelled in the view, so a Scale 1.25 bracket
exports its 120.655 × 50 blank instead of the pre-scale one; moves and scaled
copies leave it alone (`test/sheet-metal-flat-pattern.test.ts`,
`apps/web/src/components/FlatPatternDialog.test.tsx`). The Scale is found by
following the sheet's body as the build assigns its ids (`bodyPiecesAfter`,
`packages/document-core/src/body-consumption.test.ts`): through a suppressed
or failed edit's pass-through, staying on an original a Split or a Boolean
keeps; a sheet a Split divided and a Scale enlarged only in part is refused
instead of exported at a guessed scale, and curved cutouts are sampled to the
0.02 mm chord budget of the scaled part. Once a feature combines the sheet
with other material (a Boolean with another body, an add extrude, a rib, a
pattern) the ids no longer say where the sheet's own material is, so a Scale
after it is refused by name, naming the merging feature, while a Scale
before it still applies and a merged sheet with no later Scale exports as
built. The files hint names the unit in
words ("Files are at 1:1 scale in inches").
