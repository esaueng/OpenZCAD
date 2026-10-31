---
row: U01
---

Fillet/Chamfer operation tags and live size readouts share a flex row with a
fixed gap and move together around panels and viewport edges. Browser
regression `test/e2e/edge-chip-layout.spec.ts` checks rendered bounds during
held drags at desktop and narrow widths, changing digit widths, cancellation
and reopening exact numeric entry; the test reproduced a 31.5 px overlap
before the fix.
