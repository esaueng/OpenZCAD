---
row: L09
---

Maker slice 2, document print clearance (PR #PRNUM, schema v59):
`printClearance` on the document, a length in document units (a number, or an
expression with units and parameters), set under Parameters → Print
clearance as one undoable command. ISO, printable and custom threads without
their own clearance (the Thread panel's new _Document_ fit) take it as their
radial clearance; pipe threads never do. Gears without their own backlash take
it as each flank offset by it (`2c / cos α` of thinning at the pitch circle),
and the gear-mesh helper agrees. No joint has fit geometry yet:
`documentPrintClearance` is what a joint fit reads. Unset, every build is
unchanged and no stored document is rewritten; the rebuild cache digests the
resolved clearance for the features that read it (`test/print-clearance.test.ts`,
`apps/web/src/lib/inPlace/thread.test.ts`,
`apps/web/src/components/modelPanels/ParametersPanel.test.tsx`,
`test/e2e/print-clearance.spec.ts`; docs/print-clearance.md).
