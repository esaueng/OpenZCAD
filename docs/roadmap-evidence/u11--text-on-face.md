---
row: U11
---

A picked flat face offers Text beside Sketch on its selection card and in
its context menu ("Text on face"). One press opens a sketch on that face
with the text card focused. The word is pinned and centred where the face
was picked, so the pointer crossing the face on its way to Place does not
move it, and Place puts the whole word there. A click on the face still
places it where clicked. Text is refused for the same reason as Sketch.
With direct manipulation off, the card's Sketch now sketches on the picked
face instead of clearing the pick and asking for a plane. Coverage:
`selectionCallout.test.ts`, `interaction/machine.test.ts`, and
`test/e2e/text-on-face.spec.ts` (both direct-manipulation settings, as
Chromium smoke cases, plus the Sketch case).
