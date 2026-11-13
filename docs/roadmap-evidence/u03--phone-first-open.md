---
row: U03
---

12 November review follow-up: a workspace opened on an upright touch phone
shows the model. At 520 px and narrower the phone lane rests on open: no
panel is drawn until one is asked for there, the stored layout is left as it
is for a wider stage, and a second press on the lane's panel clears the lane
instead of closing the panel or falling back to another. The touch rails are
one column each there, the instrument rail folds to a short set (undo, redo,
multi-select, the five panels, Fit view from 820 px tall) behind "More view
tools", and Tools stays at the foot of a tool rail that scrolls. The clear
share of the stage under the top bar on first open of the demo went from 40%
to 75% at 390 × 844 and from 26% to 68% at 360 × 640. Coverage:
`test/panel-layout.test.ts`, `ViewerToolbar.test.tsx`,
`phoneStageContracts.test.ts`, and `phone-stage.spec.ts` in the browser,
which asserts the 60% floor, no chrome overlap and 44 px rail targets at
both sizes.
