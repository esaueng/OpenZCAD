---
row: H01
---

A History reorder that would run a step after the consumer of a body it still
uses is refused by name, with the order and the exported solid left as they
were (#2334; [ADR-025](docs/adrs/ADR-025-stable-body-lineage-identity.md)
interim reorder guard). The reported case, a cutter placement moved below its
Subtract, committed and exported the vent at the unplaced position; a reorder
of independent steps still commits with the same STEP DATA, and a stored fork
replays, stays editable and can be moved back out. Synthetic coverage:
`packages/document-core/src/body-consumption.test.ts`,
`test/consumed-cutter-reorder.test.ts`; browser coverage:
`test/e2e/history-reorder-consumed-cutter.spec.ts` (order and downloaded vent
coordinates before and after the refused move).
