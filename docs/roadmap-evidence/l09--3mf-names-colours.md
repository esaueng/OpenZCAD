---
row: L09
---

Maker slice 1, per-body names and colours in 3MF (PR #1558): each 3MF
object is named after its body and coloured in its display colour through one
core `basematerials` group (`object pid/pindex`, no extension required). Read
from the slicers' public 3MF importers: Bambu Studio (colour import shipped in
02.09.01.70) names the parts and makes one filament per distinct colour;
OrcaSlicer (main 2026-11-14) and PrusaSlicer (main 2026-11-06) name the parts
but do not read core `basematerials` (Orca reads only `m:colorgroup`). Not
confirmed in a running slicer. The exchange-loss contract now counts 3MF names
and colours as kept; the reimport still merges the objects into one body
(`three-mf-labels.test.ts`, `exchange-round-trip.test.ts`,
`test/e2e/three-mf-names-colors.spec.ts`;
docs/exchange-loss-contract.md).
