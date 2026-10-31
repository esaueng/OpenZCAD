---
row: U01
---

Standalone gear face width, follow-up to the cap-to-face-width route
(esaueng/OpenZCAD#1067). Dragging the start cap of a helical or herringbone
gear is now refused up front, because moving the origin would turn the teeth
at the far cap; its end cap stays a plain width edit. Spur gears built as their
own body share the full-span drag preview that cylinder-derived spur gears use,
proven by the same cap ancestry as the edit. `gear-face-width-cap-drag.test.ts`
covers top cap 10 → 13 → 9 mm (width and volume, cap area, tooth count,
opposite cap, unrelated bodies), stored `faceWidth`, undo/redo and
save/reopen, a bottom-cap drag that keeps the top fixed, a typed expression
under a rotated placement, the spur preview span, the zero-width and helical
start-cap refusals, and stale or local picks. `gear-face-width.spec.ts`
covers a drag from 10 to 13 mm, a typed 9 mm, reselection, undo/redo and
reload against the stored document.
