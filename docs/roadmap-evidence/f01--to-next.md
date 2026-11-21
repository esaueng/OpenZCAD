---
row: F01
---

Up-to-next slice: schema v130 adds `endCondition: 'to-next'` for an add or a
cut with one explicit target. The stored distance's sign gives the direction
and its size is dormant. Each rebuild sweeps the profile from its start plane
past the target's exact bounds and splits that sweep with the target into exact
regions (`booleanRegions`). An add keeps the regions outside the target that
stand on the start plane, so it grows until it meets the target. A cut keeps
the regions inside the target that stand on the start plane, so it removes
material only until the profile first leaves it, at a cavity or the far side.
Moving the target moves the end, and nothing derived is stored. A profile
that does not meet the target everywhere, an add that starts inside the
target, a cut that starts outside it, a target behind the start, and a deleted
target refuse by name. Symmetric, two-sided, through-all-side and new-body or
intersect combinations are refused at entry, and a feature pattern does not
repeat it yet. A start offset and a draft apply. The Extrude bar offers
Extent → Up to next for an explicit add or cut, with Reverse for the
direction. With Cut's four extents the row shows as a menu. The History row
reads "Up to next". Regression evidence: `test/extrude-to-next.test.ts` (a
hollow box: an add up to its underside and, reversed, onto its top; a cut
from the top stopping at the cavity's roof; a start offset and a drafted
prismatoid; a moved target; five named refusals; entry refusals; edit round
trip and undo; editor rules) and the `@ci-smoke` case in
`test/e2e/extrude-to-next.spec.ts` (22700 → 22500 → undo). The e2e fixtures'
`chooseBarOption` now also picks from an Options row that shows as a menu.
Remaining: multi-target and add through-all, and to-face on a slanted or
curved face.
