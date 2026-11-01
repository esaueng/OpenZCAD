---
row: D06
---

Angles and counterbore callouts. A slope square to one model axis is a
requirement, not unmeasurable: one angle per plane (mirrored copies share it)
and one corner locating it where it meets a face square to an axis (a real
edge before a virtual sharp through a blend); its other corners are derived,
and a compound slope stays unmeasurable. The check reads an existing D02
angle dimension between an edge of the slope and an axis-aligned edge in its
plane, and Auto-dimension places one in the view along the slope. Schema v50
adds a counterbored hole's callout on a diameter (`counterbore`, the bore's
rim): it reads "2× Ø6 THRU, CBORE Ø11 × 3 DEEP" from the model and states the
hole and bore diameters and the bore's (and a blind hole's) depth, so
Auto-dimension places one callout instead of two diameters and a floor span.
A bore's floor must face its opening, so a stepped shaft is never read as one.
Evidence: `test/drawing-auto-dimension.test.ts` (sloped part: 135° angle, its
corner, R5), `test/drawing-dimension-audit.test.ts`,
`test/drawing-import-dimensioning.test.ts` (imported counterbored plate:
callout, three requirements stated, a second height span repeats it; v50
validation).
