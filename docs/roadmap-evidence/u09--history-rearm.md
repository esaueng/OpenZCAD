---
row: U09
---
Phase 7: a History row re-arms the in-place command that made its feature
(revolve, loft, sweep, helical sweep, hole, shell, thicken, solid offset,
draft, mirror, split, scale, rotate about axis, the booleans and the
patterns) with its picks in the slots, its values on the chips and its
choices in Options, instead of opening a form; whatever the command cannot
show (a hole's position, a typed pull, plane or axis, a pattern's vector, a
scale's pivot) stays as stored, so an untouched Done writes the feature back
unchanged. Done commits the same `updateFeature` the cards did, validated the
same way. A Move still edits in its card (`edit.test.ts`,
`useInPlaceCommand.test.tsx`, `test/e2e/in-place-history-edit.spec.ts`,
`edit-card-lifecycle.spec.ts`).
