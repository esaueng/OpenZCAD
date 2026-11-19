---
row: U11
---

A picked cylinder wall (shaft or bore) offers Thread on its selection card,
after its own Radius edit and before Axis and Shell. Pressing it starts
Thread already sized from that wall, with no second pick, at the end nearer
the click whether direct manipulation is on or off. Cones keep Axis and
Shell only, and a curved wall is never offered Sketch or Hole. The command
bar names the pick "1 cylindrical face", and the tool drawer's "fits"
filter matches Thread and Gear teeth to it. Coverage:
`selectionCallout.test.ts`, `commandContext.test.ts`, and the Chromium
smoke cases in `test/e2e/in-place-thread.spec.ts` (both direct-manipulation
settings).
