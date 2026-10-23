---
row: U01
---

Generic planar face drags now preview the whole body from the first frame
instead of holding the last exact body behind the hatched band until the worker
answers. `stepPreviewProfile.ts` recognizes the move as the picked face plus
the curved blends on its own edges translating rigidly while the walls they
meet stretch, and declines where that is not what the exact move does (a blend
reaching past the face's plane or deeper than the face's own rounds, a curved
wall that would have to stretch). The viewport moves only that region's
vertices in place (`stepStretchPreview.ts`) and triangulates a stretched
planar face afresh from its outline once its own triangles would fold; an
outline that would cross itself refuses the frame and the exact worker
preview takes over. Exact validation on release is unchanged. On the
160-face imported holder 16 of 52 planar faces, including every large side,
are recognized, and every recognized face's preview matched the exact
kernel's bounding box exactly and its volume change within 0.1% for a 3 mm
pull and a short push. Committing an offset keeps the moved face selected
and its handle armed, instead of switching to a whole-body selection that
recoloured the part and offered Move (`test/step-preview-profile.test.ts`,
`packages/viewport/src/gizmo/stepStretchPreview.test.ts`).
