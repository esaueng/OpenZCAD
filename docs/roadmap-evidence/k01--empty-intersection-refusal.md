---
row: K01
---

An Intersect whose operands share no volume (created apart, or edited out
of contact) refuses with the typed `boolean/invalid_input/empty_result`
reason "… do not overlap, so nothing would be left" instead of throwing an
untyped "solid has no vertices" out of the whole document sync: the kernel
answers a disjoint intersect with an empty solid, which the adapter now
refuses before measuring. Clash probes still read the empty answer as no
shared volume (`test/boolean-empty-intersection.test.ts`,
`exact-boolean-refusal.test.ts`). Found by the K10 box × sphere sliver
source-shrink cell on Remus 1.142.
