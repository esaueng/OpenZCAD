---
row: D07
state: Partial
---

Slice A, datum feature symbols and feature control frames on drawing views
(schema v98, built on v97; [design](docs/plans/drawing-gdt-design.md#slice-a-datum-symbols-and-feature-control-frames-schema-v98)):
the Datum feature tool (Q) declares a datum letter (A–Z without I, O and Q,
then doubled) on an edge or on a size dimension or frame, and the Feature
control frame tool (F) states any of the fourteen ASME Y14.5-2018 / ISO 1101
characteristics with a tolerance in the sheet's units, an optional Ø zone,
Ⓜ/Ⓛ modifiers and up to three datum references, pointing at an edge with a
leader or attached under a size dimension. The validator refuses what the
standards forbid by name (a datum on a form tolerance, orientation or runout
without one, Ø or a modifier where the characteristic takes none, a datum
named twice). They resolve on every draw like any annotation and break by
name rather than rebinding: `datum-duplicate`, `datum-undefined` (datums
count across every sheet), `host-missing` and `host-broken` (cascading from
a dimension to its frame to a datum symbol on it). Symbols and circled
modifiers are drawn as strokes, since sheet text is WinAnsi Helvetica, and
go through the one page model to preview, PDF, SVG and DXF; a sheet without
them lays out unchanged. Evidence: `test/drawing-gdt.test.ts` (validation by
name; on kernel bodies a datum A on a box's bottom, a perpendicularity frame
on its side and a Ø0.1 Ⓜ position frame under a pin's diameter with datum B
hanging from it, laid out per Y14.5; each break; a parameter-widened box
followed by lineage; every characteristic's symbol inside its cell; SVG, PDF
and DXF text and byte-stable reload; tool drafts, re-pick onto a host, next
letter; undoable commands and the v97 gate), `DrawingWorkspace.test.tsx`
(frame properties: form tolerances take no Ø, modifier or datum,
perpendicularity names declared datum A, a non-positive tolerance reverts)
and `test/e2e/drawing-gdt.spec.ts` (datum A picked on a box, a frame
attached under its width dimension made parallel to A, exported to SVG and
reopened). Open: general-tolerance blocks and hole/thread tolerance classes,
model-based definition and AP242 semantic PMI.
