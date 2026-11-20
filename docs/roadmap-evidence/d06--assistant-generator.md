---
row: D06
state: Complete
---

Close-out (audit of the row contract against main, 2026-11-20). Slice E's
second half: the assistant now dimensions a sheet through the deterministic
generator. `auto_dimension_drawing` (`viewIds` or null, `dimensionKinds` or
null among linear, diameter, radius, chamfer, angle) states only scope and
style; the Draw workspace runs Auto-dimension on the sheet's own annotations,
`preflightDrawingPatch` keeps what the scope covers and returns what it leaves
out (excluded kinds, dimensions that belong in other views, generator skips,
section advice) for the preview status, refuses a scope that leaves nothing to
add, and still gates on the dimension check. A Ø span counts as a diameter;
Apply applies exactly the previewed plan, and only for that proposal on that document; the request
is proposed alone and never names the isometric view
(docs/plans/drawing-auto-dimensioning-plan.md#assistant-integration). The
plan's corpus gains the bracket with fillets and a slot: zero missing, zero
repeated, nothing skipped. Evidence: `test/drawing-assistant-operations.test.ts`
(real kernel: all-views plan applied as one undo step, scope reports, refusals,
Ø-span scoping, Apply of the previewed plan), `test/drawing-auto-dimension.test.ts`
(bracket), `apps/web/src/lib/assistant/describe.test.ts`,
`test/e2e/drawing-assistant.spec.ts` (fake provider: a radii-only scope
reports the three spans it leaves out; the whole sheet's three spans
previewed, applied and undone as one step). The fake-provider e2e the plan
asks of slice E already shipped with #1081. Left open, by design: ordinate
style (needs a new annotation kind and schema, outside the row's contract)
and choosing an individual datum per request (the generator's one-datum rule
decides; a specific dimension is still proposed with
`add_drawing_annotations`).
