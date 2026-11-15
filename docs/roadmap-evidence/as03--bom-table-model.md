---
row: AS03
---

BOM table model: `assemblyBomTable` (`packages/document-core/src/assembly-bom.ts`)
turns the derived BOM into the one table every reader takes: fixed columns
(`item`, `quantity`, `part`, `instances`, `source_body`, `status`, keyed by
the CSV header with a display label and a numeric flag), plain-text cells
with no locale, each row's component ids, and the item number of every
component (`itemByComponent`, what a drawing balloon on any instance reads).
The CSV is written from the table, byte for byte as before. The Assemble
sidebar shows each row's item number, lights up the row of a part picked on
the model or in Parts, and picks every instance of a row when the row is
clicked (a second click clears it). Rows and CSV are unchanged by posing or
dragging parts and after save and reopen; a missing part keeps its number so
later numbers never shift. No schema change. Drawing presentation of the
table remains open (D01/D02). Evidence: `test/assembly-bom.test.ts` (table
cells and columns, item numbers, CSV equality, pose and reopen invariance,
missing-row numbering), `AssemblyPanel.test.tsx` (row pick and highlight)
and the CI smoke case in `test/e2e/assembly-bom.spec.ts` (pick on the model
lights the row, a row picks its part, a drag to the joint limit leaves the
rows and the downloaded CSV identical).
