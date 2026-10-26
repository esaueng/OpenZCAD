---
row: U09
---
Extrude edits run in place too, and the extrude card is gone: a History row
(or the Inspector's Edit extrude) re-arms the in-place Extrude seeded from the
stored feature, expressions as written, with its own distance arrow, the back
arrow and the draft rig on the model and its extent (to-face target and
through-all side included), Sides and stored operation and target under the
bar's Options; an edit never infers an operation. Done commits through the
same `updateFeature` the card's Apply used, validated and refused the same
way (its refusals said in the bar), and an untouched Done writes the feature
back exactly as stored (`extrudeEditData`). `ExtrudeForm`,
`ExtrudeExtentControls`, `ExtrudeControls` and the Inspector's extrude branch
are deleted (`extrudeEditing.test.ts`, `ExtrudeCommand.test.tsx`,
`extrude-edit-in-place.spec.ts`, `extrude-intent.spec.ts`,
`extrude-through-all.spec.ts`, `extrude-to-face-draft.spec.ts`,
`feature-history.spec.ts`, `solid-result-options.spec.ts`).
