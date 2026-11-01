---
row: U01
---
Reloaded cached geometry stays viewable while topology edits wait for a complete
current-revision result. Offset, radius, edge and legacy resize handles use the
same displayed-geometry capability as release validation; an already validated
commit remains immediately editable during its background echo. Offset release
outcomes distinguish blocked gestures from geometric refusals, resetting a
blocked handle/ghost without discarding intentional last-valid refusal previews.
`test/e2e/reload-face-offset.spec.ts` holds the reload worker, then checks the
first permitted pointer drag, one history entry, the measured body span and a
stable Total through reselection and another reload. Existing three-direction
`face-offset-continuity.spec.ts` coverage retains validation continuity.
