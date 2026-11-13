---
row: M15
---

A thread that stops short of its face keeps its cone chamfer at the end of
the face it starts from and stops plain: the in-place Thread tool stores
`chamferStart` or `chamferEnd` for each end the span reaches instead of
dropping both, and reads "plain where it stops". Which ends a span reaches
is read from its resolved offset and length against the face, within the
kernel's snap, not from how the length is stored: a length held as an
expression or stored by an earlier edit keeps both chamfers where it runs
the whole face and the far one where an offset span reaches it, from either
end and either axis direction, and such a thread reopened from History and
finished untouched is written back as stored; a History edit rewrites the
flags only where the edited span stops reaching an end
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
