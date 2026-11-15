---
row: M07
---

Pushing an opening's floor across it now closes windows with rounded
corners and drafted sides too. The swept region is built exactly as a box
split by the face's planes, which reproduces the kernel's re-limited move for
any side tilt on a convex face. The floor's own fillets travel with it, and
blends the sweep swallows are removed with the kernel's defeature before the
union, because the exact union refuses tangent contact. The fallback declines
a push that would grow the body past its own extent, or one shorter than its
blends. Delete on the wall of a hole a subtract cut (a round port) heals the
face in place, as it does on an imported part, instead of deleting the cutting
tool the subtract needs (`test/close-opening-direct-edit.test.ts`).
