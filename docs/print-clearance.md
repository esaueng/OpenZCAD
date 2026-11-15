# Print clearance

One document-level value for printed fits (L09, schema v59): the radial gap a
printed part leaves to the part it mates with. Set it under **Parameters →
Print clearance**: a length such as `0.15`, or an expression with units or
parameters such as `0.2 mm` or `2 * gap`. Blank means none.

## What reads it

| Reader                          | Reads the print clearance when               | As                                                                                                                                      |
| ------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Thread (ISO, printable, custom) | its own clearance is unset (Fit: _Document_) | its radial clearance: a boss shrinks and a bore grows by it                                                                             |
| Thread (NPT, BSPT)              | never                                        | a pipe thread mates standard fittings and keeps its own fit                                                                             |
| Gear (every type)               | its own backlash is unset                    | each tooth flank offset by it along its normal: a tooth thinning of `2c / cos α` at the pitch circle (the gear-mesh pair helper agrees) |
| Joint fits                      | —                                            | no joint has fit geometry yet; one that does reads `documentPrintClearance` in document-core the same way                               |

A thread's or gear's own value always wins, zero included. The Thread panel's
_Exact_ fit therefore stores a clearance of 0, and its _Document_ fit stores
none. A thread saved before this change with the _Exact_ fit has no stored
clearance, so it follows the print clearance once one is set; choose _Exact_
again to keep it at nominal size.

For a helical gear the declared (normal) pressure angle is used, so the
thinning is approximate there; it is exact for spur gears and racks.

## Unset changes nothing

A document without a print clearance builds exactly as before: threads and
gears without their own value take no gap, and no stored document is
rewritten when it opens. A document that sets one declares schema v59, so an
older build refuses it rather than building those threads and gears without
the gap.

A clearance that stops resolving (a parameter it reads was deleted, retyped or
made negative) fails the threads and gears that read it with a message naming
the print clearance. Renaming a parameter rewrites the clearance with it, and
a parameter the clearance reads cannot be deleted.

Tests: `test/print-clearance.test.ts` (resolution, schema gate, undo and
replay, parameter rename and delete, kernel builds of threads and gears and
the rebuild cache), `apps/web/src/lib/inPlace/thread.test.ts` (the _Document_
fit), `apps/web/src/components/modelPanels/ParametersPanel.test.tsx` (the
row) and `test/e2e/print-clearance.spec.ts`.
