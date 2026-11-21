---
row: F01
---

Multi-target through-all slice: a new through-all cut can go through more
bodies than its target. The result-body and consumption contract is one
through-all cut per body: each extra body becomes its own through-all
extrude of the same profile and side, consuming and replacing that body
exactly as a single-target through-all cut does (ADR-017 pass-through and
ADR-025 single replacement are unchanged). All of them are created and
undone as one step (`composeCommands`). No stored field or schema changes:
each feature is the through-all cut every client since v20 builds, and
editing one later changes that body's cut only. The explicit cut choice
carries the extra bodies (`alsoTargetBodyIds`) through the preview, which
holds every cut, and the commit. A body named twice, the target named again,
or a body the profile misses refuses the whole step by name. The Extrude bar
offers "Also cut" rows (one per extra body, another appearing until none is
left) under a through-all cut being created, and the status line reads "Cut
the region through all of 3 bodies." Regression evidence:
`test/extrude-through-all-multi.test.ts` (three plates each cut 4000 − 160 by
their own through-all feature, a preview holding all three, one undo removing
all, refusals, no extra cut off through all, editor rules) and the
`@ci-smoke` case in `test/e2e/extrude-through-all.spec.ts` (target and Also
cut picked in the bar, both plates 15000, one undo). Remaining: to-face on a
curved face.
