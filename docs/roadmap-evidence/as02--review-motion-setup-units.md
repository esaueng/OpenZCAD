---
row: AS02
---

Design review 2026-11-13 I55/I56/I60/I61 and the joint part of I2: Set up
motion offers only parts that are neither fixed nor already moved by a joint,
and the header's Motion button says why when none is left instead of opening
a card already in an error; assembly lengths (Set up motion range, joint
rows and details, the Joint tool's limits, the timeline and the drag chip)
read the document's unit, with inch, cm and m defaults, where they always
said "mm"; the first-run card hands "fixed" to a ticked body when the fixed
one is unticked; joints get a visible Delete (and the Delete key) announced
with Undo; fixed pins are filled, not only coloured; the Scissors joint is
named Pivot (`motionSetup.test.ts`, `assemblyUi.test.ts`,
`AssemblyPanel.test.tsx`, `AssemblyFirstRunCard.test.tsx`,
`test/e2e/assembly.spec.ts`).
