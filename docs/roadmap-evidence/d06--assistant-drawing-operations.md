---
row: D06
---

Slice E, first half: asked from Draw, the assistant proposes dimensions and
notes on the open sheet. `add_drawing_annotations` and
`remove_drawing_annotations` (strict schema, nullable fields) name edges only
by the refs the sheet digest lists per drawn view (`v1:e4`, with page-mm ends,
centres and face-on circles); digest validation grounds each ref to its model
edge, and the app adds the lineage a pick would store. A proposal is previewed
on the sheet only once every annotation resolves and the dimension check finds
nothing repeated; missing sizes are reported in the digest's audit, not
refused. It applies as one undoable step; model edits stay out of Draw.
Consent copy v2 lists `digest.drawing`. The deterministic generator (slice C)
plugs in at `preflightDrawingPatch`. Evidence:
`packages/ai-contracts/src/drawing-annotations.test.ts`,
`test/drawing-assistant-operations.test.ts` (real kernel plate: digest, two
dimensions applied and undone as one step, replay, refusals) and
`AssistantPanel.drawing.test.tsx` (fake provider proposes two dimensions).
