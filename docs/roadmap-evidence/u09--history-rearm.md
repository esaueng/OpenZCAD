---
row: U09
---
Phase 7: a History row re-arms the in-place command that made its feature
(revolve, loft, sweep, helical sweep, hole, shell, thicken, solid offset,
draft, mirror, split, scale, rotate about axis, the booleans and the
patterns) with its picks in the slots, its values on the chips and its
choices in Options, instead of opening a form. What the cards typed is typed
on chips, expressions kept: a mirror or split plane, a helix axis, a draft's
pull and hinge, a hole's U and V, a scale's pivot, a loft apex, a pattern's
vector, so an untouched Done writes the feature back unchanged. Values and
options the user has not changed follow the feature when someone else
changes it. Done commits the same `updateFeature` the cards did, validated the
same way. A Move still edits in its card (`edit.test.ts`,
`useInPlaceCommand.test.tsx`, `test/e2e/in-place-history-edit.spec.ts`,
`edit-card-lifecycle.spec.ts`).
