---
row: F01
---

Slanted to-face slice: a to-face extrude now reaches a planar face that
leans off parallel to the sketch, within about 84° (`TO_FACE_SLANT_COSINE_LIMIT`).
It adds no stored field and no schema bump, and an older client still refuses
such a target as unresolved. A parallel face keeps the derived blind distance
it always had. For a slanted face, each rebuild re-finds the face by its
verified lineage and reads the profile's footprint from a unit probe sweep's
exact bounds. It sweeps from the start plane past where the face plane meets
that footprint, then splits each swept solid with the kernel's exact plane
`split`, keeping the half that stands on the start plane. An offset from the
face moves the plane square to the face, and a start offset and a draft apply.
A face nearly perpendicular to the sketch, or one whose middle lies on the
start plane, reads as unresolved (a re-pick repairs it). A face plane that
crosses the profile where it starts, or a draft that flares past the face,
refuses by name. The extrude card and the pick prompts now ask for a face
facing the sketch, and the offset and start checks wait for the build on a
slanted face. Regression evidence: `test/extrude-to-face-slanted.test.ts`
(closed forms for a ceiling turned 10°, −25° and 40° (16 × 25, top at
25 + 2 tan θ), an offset 3 / cos 30° lower, a start offset, a slanted face
below the sketch, a cut down to a slanted floor on another body, draft
bounds, a plane crossing the profile, a turned face followed, and a face
turned 87° unresolved; editor rules),
`test/extrude-to-face-draft.test.ts` (an 88° turn is unresolved) and the
`@ci-smoke` case in `test/e2e/extrude-to-face-draft.spec.ts` (400 on a face
turned 10°, 351.26 with 3 mm short, undo to 400). Remaining: multi-target
and add through-all, and to-face on a curved face.
