---
row: K10
---

A chamfer the pinned kernel refuses beside a holed flat face is typed: a rim
chamfer next to a through bore in the same top face used to refuse as
`internal` under the kernel's catch-all `fillet-failed` code; the adapter now
files it as `unsupported` (`chamfer_face_with_hole`, reason `fillet-failed`)
with a sentence naming the verified remedy (chamfer before the hole is cut),
scoped to a catch-all refusal at every probed distance on an outer-loop edge
of a planar face with an inner loop (`test/boolean-role-correction.test.ts`
Cell 4b, `test/adapter-refusal.test.ts`). Cell 4c pins a separate wrong-volume
floor-rim chamfer as `it.fails`.
