---
row: M07
---

Multi-face Offset, parallel planes (slice 1): `offset-faces` now moves faces
that all face the same way but lie on parallel planes at different heights
(a stepped top, a slot floor with the tops beside it). Remus refuses one
`moveFaces` call on such a set, so the adapter chains one exact journaled
move per plane, leading plane first, carrying the later faces through each
step's journal face map; only the final solid is validated. No schema bump
and no new Remus API. Opposite normals, faces that share an edge and other
mixed directions are refused by name, as is a later step that would change
the body's topology. Each chained result matches the same moves made as
single `offset-face` features, whatever order the faces are stored in.
`test/offset-faces-direct-edit.test.ts`, `test/parity/offset-faces.spec.ts`.
