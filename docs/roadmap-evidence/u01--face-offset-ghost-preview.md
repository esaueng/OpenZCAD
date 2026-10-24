---
row: U01
---

Throughout a face offset's drag and validation the body is drawn solid as it
will be (the viewport proxy or the exact preview, no longer tinted the preview
mint), over a translucent ghost of the part as it was with the dragged face at
its old place (`bodyGhost.ts`): the ghost sits behind the solid in depth, so a
cut shows exactly the material it removes and a pull hides it, and the hatched
band is hidden meanwhile. The handle now rides the face to its new level both
ways, with a dashed dimension back to the old level that the value label rides
(`rigs.test.ts`).
