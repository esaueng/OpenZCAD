---
row: F06
---

A drawing view pinned to a configuration row, and every view projected,
cut, detailed or seen from it, now measures that row's bodies: its
dimensions, Dimension Check requirements and Auto-dimension proposals read
the row's geometry instead of the active row's, a section keeps its
dimensions while the active row suppresses its body, and a view never
measures a body its row does not build. A sheet left stale by a row switch
keeps each view on the row it drew, and a stale exploded sheet keeps the
parts list and balloon numbers of the assembly its views drew, so exports
show one model state (`DrawingWorkspace.pinnedRows.test.tsx`,
`DrawingWorkspace.staleAssembly.test.tsx`).

Review follow-up: a pinned view's hole table and bore callouts read its own
row's hole sizes (a kept sheet keeps each row's), a row view's cache key
covers everything a rebuild reads (the feature order included), a row the
model cannot take fails its own views instead of Draw, Dimension Check lists
a view whose row is still building as not checked, and only the bodies a
row's views draw are kept of its build, within a byte budget for sheets not
on screen (`rowBodies.test.ts`, `configuration-views.test.ts`).
