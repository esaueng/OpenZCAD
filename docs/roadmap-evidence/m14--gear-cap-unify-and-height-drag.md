---
row: M14
---
Teeth cut along a cylinder leave each end cap as one face: Remus
`cutGearTeethDetailed` returns the blank's disc and the toothed ring as two
coplanar faces, which the adapter now unifies in place
(`unifyFacesChecked`) and names `gear.face.cap.start|end`. Dragging a gear
cap edits the source cylinder's height, which re-cuts the teeth, instead of a
local face move the kernel refuses (it cannot extend the NURBS involute
flanks). The gear stays opaque to cylinder radius drags. Evidence:
`test/gear-cap-height-drag.test.ts` (one named cap per end whose area is the
prism's cross-section; top and bottom cap drags plan as cylinder height edits
and rebuild with 40 named flanks and the opposite cap fixed; no radius
ancestor through the gear).
