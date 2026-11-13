---
row: M15
---

A partial thread keeps its cone chamfer at the end of the face it starts
from and stops plain: the in-place Thread tool stores `chamferStart` or
`chamferEnd` for the end the span reaches instead of dropping both, reads
"plain where it stops", and round-trips through History
(`apps/web/src/lib/inPlace/thread.test.ts`, `edit.test.ts`,
`test/e2e/in-place-thread.spec.ts`). On the exact kernel a 5 mm M6 thread
on an 8 mm boss matches its closed-form volume, and its one cone, from
either end of the face, takes a volume inside the closed-form bounds of a
45° cone through the end plane between the root and a tenth of the depth
below it. A chamfer on the end that stops short of the face now refuses
before the kernel is asked, as `thread:chamfer-short-of-face`
(`unsupported`), where the kernel answered `thread:invalid-parameter`
(`test/thread-feature.test.ts`). Still open, both blocked on the kernel
(esaueng/remus `thread.rs` at the pinned v2026.1.135 lists them as not
covered, and `cutThreadDetailed` rejects a taper field as unknown): a
chamfer on the stopped-short end itself, and tapered (pipe) threads.
