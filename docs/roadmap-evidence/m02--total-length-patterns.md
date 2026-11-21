---
row: M02
---

A total-or-spacing choice for linear patterns (schema v120, up from v119; no
kernel change). A linear `pattern` may store `spacingMode: 'total'`: its
`spacing` is then the distance from the original to the last copy, and the
copies stand `spacing / (count − 1)` apart, so a changed count keeps the
row's length. Absent keeps the spacing between copies, so every older
pattern builds unchanged. Refused: the mode on any other kind, an unknown
mode, and below v120 by the content gate; `clearData: ['spacingMode']`
returns a pattern to the spacing between copies. The quick parameter
preview shares the total out as the build does. UI (U11 pick-and-drag): the
Linear pattern tool's Options gain Spacing (Between copies, Total length);
with Total length the arrow is the last copy and drags the row's length,
and each copy's chip stands at its share. A History edit reopens with
Total and writes it back unchanged; switching back to Between copies
clears the mode. History reads "× 4 over 60 mm". Evidence:
`test/pattern-total-length.test.ts` (four blocks over 60 standing 20 apart;
a hole row over 60 keeping its length from three to four copies, bore axes
and volume in closed form; the document, clear and v120-gate refusals);
`apps/web/src/lib/inPlace/tools.test.ts`, `edit.test.ts` and
`featureSummary.test.ts`; `test/e2e/pattern-total-length.spec.ts`, which
picks a block, chooses Total length, drags the last copy and checks the
stored mode and its History row.
