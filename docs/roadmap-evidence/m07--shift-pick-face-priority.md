---
row: M07
---

While faces of one body are held, a Shift pick on that body takes the face
under the pointer ahead of the edge bounding it, so a 2 mm wall seen at an
angle can be added to a face set instead of turning the set into an edge
selection. A second click on the same spot still steps to the edge
(`apps/web/src/components/viewer/faceSetPick.test.ts`).
