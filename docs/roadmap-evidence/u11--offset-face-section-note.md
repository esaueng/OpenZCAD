---
row: U11
---

Offset Face says when the section view hides part of it: while an active
section cut hides part of the face being offset, a face set's faces or the
previewed result, the command bar shows "Section view hides part of this face"
with Turn off section, and nothing otherwise. Decided from the faces' mesh
bounds, moved by the previewed offset, against the section plane
(`apps/web/src/lib/faceOffsetSectionVisibility.test.ts`,
`offset-face-section-note.spec.ts`).
