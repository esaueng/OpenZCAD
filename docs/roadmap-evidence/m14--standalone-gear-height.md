---
row: M14
---

Standalone external and internal gear cap edits update the authored face width
instead of requesting a local extension of the involute flanks. The near cap
also shifts the gear's stored origin so the opposite end stays fixed. Routing
requires a current named cap owned by that gear; teeth on a cylinder,
bevel/worm gears, stale picks and locally edited results keep their existing
routes. Expressions are retained and nonpositive widths are refused before
rebuilding. `test/standalone-gear-height-drag.test.ts` covers 40 to 25 mm,
unchanged sibling/topology/volume, undo/redo, reopening, STEP round-trip and
the near cap of an X-axis gear. `faceOffsetPlan.test.ts` covers expressions,
refusals and ancestry boundaries. `standalone-gear-height.spec.ts` exercises
the actual Total keypad and checks the exported project still contains one
gear feature with a 25 mm face width.
