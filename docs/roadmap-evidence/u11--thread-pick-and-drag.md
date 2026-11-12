---
row: U11
---

Thread, second tool: one pick, a cylindrical face or hole, and the thread
starts at the end of the face nearer the click (an edit keeps its stored end);
its diameter and length come from the face, and one arrow on the thread's free
end, bounded by the face's far end, stops it short for a partial thread
(Extent and From are no longer options); Options reads out what the face and
the arrow decide ("Sized from the Ø6 mm face · Threads 8 of 12 mm, ends
plain"); an untouched History edit writes the feature back unchanged, a stored
partial thread included, with no schema change; a length arrow's chip now hangs
clear of its head instead of covering it (`thread.test.ts`, `edit.test.ts`,
`useInPlaceCommand.test.tsx`, `in-place-thread.spec.ts`,
`extrude-in-place.spec.ts`).
