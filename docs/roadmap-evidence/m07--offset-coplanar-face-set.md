---
row: M07
---

Multi-face Offset, contract and kernel slice: a new replayable direct edit,
`offset-faces`, moves a set of coplanar faces of one body together by one
signed distance through a single Remus `moveFaces` call (no schema bump: older
builds refuse the unknown kind instead of moving only the first face). Every
face is pinned like `remove-faces`; a re-pick repairs the first face, and a
drifted other face refuses with "Select the faces again". Faces that face
different ways, or are parallel at different heights, are refused by name;
chained moves for such sets remain open, as does the workspace verb.
`test/offset-faces-direct-edit.test.ts`, `test/parity/offset-faces.spec.ts`.
