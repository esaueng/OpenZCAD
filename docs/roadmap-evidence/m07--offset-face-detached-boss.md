---
row: M07
---

Offset Face and Offset Faces no longer commit a kernel result that carries a separate curved support with the moved face. On a box fused with an r6 boss whose seams with the front face and the top are rounded r1, the pinned kernel returned an exact, valid body with the boss translated by the offset; the adapter now refuses it with the typed `offset_face_carried_detached_support` reason through both the drag preview and the commit rebuild, and the boss stays where its feature placed it (`exact-offset-face-detached-carry.test.ts`, `test/parity/offset-face-detached-boss.spec.ts`).
