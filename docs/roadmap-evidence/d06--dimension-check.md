---
row: D06
state: Partial
---
Slice A, the dimension check: Draw's panel reports, for a sheet that matches
the model, which sizes and positions its dimensions state, which are missing,
which are repeated (a second dimension on one size group, a closed chain such
as 50 = 41 + 9, or a span to a blend's tangent the radius already fixes) and
which no D02 dimension can place yet (revolved blend radii, chamfers and
tapers, bolt-circle pitch diameters, positions only closed circles mark).
Positions per model axis are planar faces square to it and hole/boss axes;
blends tangent to a face are positioned by their radius; three or more equal
holes equidistant from a turned axis are one bolt circle, not per-hole X/Y
positions. Read from the current model like every dimension; nothing stored,
no schema change. Evidence: `test/drawing-dimension-audit.test.ts` (on real
kernel bodies: the turned foot of the design, a stepped part's closed chain, a
plate's hole located by its centre, a bolt circle, a rounded corner's derived
tangent) and `DrawingWorkspace.test.tsx` (missing list on a ready sheet; a
repeated dimension selects from the check).
