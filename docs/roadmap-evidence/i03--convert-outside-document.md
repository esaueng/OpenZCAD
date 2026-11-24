---
row: I03
---

Stored-unit conversion also rescales this device's view state outside the
document: the remembered camera and section cut, the cut remembered while
sectioning is off, and saved views. Each now records the unit it is in, is
rescaled through the camera's unit-change path on a conversion, its undo, redo
or checkpoint restore, and is rescaled on read when it was written in another
unit (`useProjectView.test.tsx`, `savedViews.test.ts`,
`ViewerToolbar.test.tsx`, `convert-stored-units.spec.ts`). The per-user linear
snap and comment pin anchors are left as follow-ups.
