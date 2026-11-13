---
row: U03
---

`test/e2e/overlay-reach.spec.ts` UI-06 (an open menu moves back inside a
window resized under it) failed about half its runs outside the smoke set:
it right-clicked four fixed fractions of the canvas while the reframe a mode
change asks for was still pending or gliding, and a press on the canvas stops
that glide where it stands, so the points landed on one face or on empty
stage and Select other never opened. The product was right. The case now
waits for the view to rest, right-clicks a point the viewer reports as a real
stack, checks the list's rows, proves the list starts outside the smaller
window, and joins the CI smoke set.
