---
row: H01
---

A History reorder that would run a step after the consumer of a body it still
uses is refused by name, with the order and the exported solid left as they
were (#2334; [ADR-025](docs/adrs/ADR-025-stable-body-lineage-identity.md)
interim reorder guard). The reported case, a cutter placement moved below its
Subtract, committed and exported the vent at the unplaced position; a reorder
of independent steps still commits with the same STEP DATA, and a stored fork
replays, stays editable and can be moved back out. A stored fork exempts only
the step-and-consumer pairs it already holds, and a transaction is judged by
the order it ends on, not each move on the way. A suppressed step counts as
a consumer only while its pass-through takes the body, so one that an earlier
consumer left nothing to pass may be moved among the later steps. Synthetic
coverage:
`packages/document-core/src/body-consumption.test.ts`,
`test/consumed-cutter-reorder.test.ts`; browser coverage:
`test/e2e/history-reorder-consumed-cutter.spec.ts` (order and downloaded vent
coordinates before and after the refused move, and the refusal by name while
the exact rebuild is still pending).
