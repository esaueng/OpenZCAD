---
row: AS03
---

Stored exploded-view offsets (schema v61, `assembly.explode`; builds on v59,
v60 is claimed by the L09 print clearance): one world translation per
component, applied after its solved pose, presentation only (no effect on
the joint solve, couplings, playback, BOM or rebuild). Assemble's sidebar
gains an Exploded view section: Assembled / Exploded (a view toggle, never
saved), the number of parts pulled out and Reset. While exploded, a drag on
any part slides it along the world axis X, Y or Z that best matches the
pointer, snapped to the document's length step (Shift free, Escape cancels),
with an "X +25.0 mm" chip; release saves `assembly.explode.set` as one undo
step, and Reset clears every offset as one. Offsets are stored in display
order without zeros, go with a deleted part, reopen exactly after save and
reload, and are refused for unknown parts, reserved keys or bad vectors;
an older client refuses the document. Room merges keep offsets on different
parts once the view has one, and an offset with a pose made elsewhere; two
offsets for one part, an offset on a part removed elsewhere, and the first
offsets made on two devices at once are conflicts. Joint tools, Set up
motion and Place gears return to the assembled view. Contract:
docs/plans/assemblies-plan.md (Exploded view). Explode playback in motion
studies is not asked for by the plan and is not built; exploded drawing
views wait on D01/D02. Evidence: `test/assembly-explode.test.ts` (undo and
redo, canonical storage, reset, pruning, presentation-only, reopen, v61
gate, validation, merges), `apps/web/src/lib/assembly/explodeView.test.ts`
(view matrices and glyphs, drag override, axis choice and snapping on a real
camera, runtime commit and tool interplay), `AssemblyPanel.test.tsx`
(toggle, count, Reset and undo) and the CI smoke case
`test/e2e/exploded-view.spec.ts` (pick and drag Blade B out along one axis,
Escape cancels, one undo, Assembled restores the view and keeps the offset,
reload reopens it).
