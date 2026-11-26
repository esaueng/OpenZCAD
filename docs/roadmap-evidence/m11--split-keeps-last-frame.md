---
row: M11
---

2026-11-26 Split keeps its last frame under a refusal (owner decision D5),
on the Remus 2026.1.171 pin (`f210583`). A Split value the kernel refuses no
longer takes the preview down: as Hole, Fillet and Chamfer already did, the
last two-halves frame that built stays on screen, the bar names the refused
input ahead of the typed sentence ("Offset: The cutting plane does not pass
through the body…"), Done stays disabled and the body and plane stay picked.
`splitRefusedInputs` (`apps/web/src/lib/inPlace/tools.ts`) tells the inputs
apart from what each frame was made from, since the request stores the plane
already slid: `Offset`, `Plane` for another face, datum or principal pick or a
switch between a picked and typed plane (a re-pick's reset offset is not
named), `Origin` and `Normal` for a typed plane, and `Original`. A different
body is another target (`null`): a frame kept under a refusal comes down with
that refusal as soon as the other body is picked, a late frame of the old body
is never drawn for the new one, and once another body's refusal lands the old
frame is no longer kept. Hole, Fillet and Chamfer never return `null`, so their
behaviour is unchanged. The first face pick
at offset 0 has no earlier frame and keeps none; superseded frames still never
become the kept frame. `useInPlaceCommand.test.tsx` covers the offset, a
re-picked plane, another body, the first pick and Escape (no commit);
`tools.test.ts` covers each named input; `test/e2e/split-recovery.spec.ts`
now asserts the kept x = 52 halves and "Offset:" at +8, then Done again at
−38.
