---
row: M07
---

Multi-face Offset, faces in different directions (slice 2): `offset-faces`
now moves planar faces that face different directions, whether they meet at
an edge (a pocket's floor and walls, a boss's side walls, two outer walls at
a corner) or lie apart (a boss top with a far side wall). The adapter chains
one exact journaled move per plane, each along its own normal, in a
geometry-only order (direction classes by descending normal z, y, x; leading
plane first within a class), so each shared edge ends where the moved planes
meet. Two faces with opposite normals are still refused, as is a later step
that would change the body's topology. No schema bump, no new Remus API, no
workspace change. Each result matches the same moves as single
`offset-face` features, in either order, whatever order the faces are
stored in. `test/offset-faces-direct-edit.test.ts`,
`test/parity/offset-faces.spec.ts`.
