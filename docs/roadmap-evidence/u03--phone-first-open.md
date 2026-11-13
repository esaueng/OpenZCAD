---
row: U03
---

12 November UI/UX review, the workspace on a phone: a workspace opened on an
upright touch phone shows the model. At 520 px and narrower the phone lane
rests on open: no panel is drawn until one is asked for there, the stored
layout is left as it is for a wider stage, and a second press on the lane's
panel clears the lane instead of closing the panel or falling back to another;
View's parts list waits the same way. The touch rails are one column each
there, the instrument rail folds to a short set (undo, redo, multi-select, the
five panels, Fit view from 820 px tall) behind "More view tools", and Tools
stays at the foot of a tool rail that scrolls. The model's first frame is
fitted between the rails rather than to the whole canvas, and what stands over
the search bar keeps between them too: a pick's guidance card (with the view
cube stepping above it), the bar's help and an empty project's invitation.
The share of the stage under the top bar that no chrome covers, on first open
of the demo with a layout stored on a wider screen, went from 44% to
76% at 390 × 844 and from 33% to 68% at 360 × 640. Coverage:
`test/panel-layout.test.ts`, `fitFrame.test.ts`, `ViewerToolbar.test.tsx`,
`phoneStageContracts.test.ts`, and `phone-stage.spec.ts` in the browser, which
asserts the 60% floor, the part inside the clear stage, no chrome overlap and
44 px rail targets at both sizes, and View, Tweak, Assemble and Draw at
390 × 844. Also from that review's test run: Escape from a typed face offset
left a retired highlight fading on a cleared set, which kept the viewport
drawing a still scene at full rate (`viewer-steadiness.spec.ts`).
