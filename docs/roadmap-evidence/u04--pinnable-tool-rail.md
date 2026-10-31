---
row: U04
---
Pinnable, context-aware verb rail: the rail's tools are the user's pins
(`pinnedTools` in the device panel state, the original eight by default),
dragged from the More tools drawer, reordered by dragging or Alt+↑/↓ and
unpinned onto the drawer, with a rail-sized drag icon and landing slot. Under
the pins up to three suggestions follow the pick and the document (a closed
profile, two bodies, one body, an empty document), recently used first, never
a tool that cannot run. The drawer opens simple (what fits and is not on the
rail) and expands to an advanced, stage-height sheet with search, Ready
now/All, keys and pin toggles; the switch between them stays at one spot at
the foot, and the view and filter are remembered. Seventeen tools got drawn
glyphs and the booleans unite/subtract/intersect, so none reuses another
surface's icon (viewer grid and section, Objects layers, Settings, sketch
spline/rotate). Evidence:
`apps/web/src/lib/toolRail.test.ts`, `apps/web/src/components/CommandCard.test.tsx`,
`test/panel-state.test.ts` and `test/e2e/tool-rail-pins.spec.ts` (browser drag
and drop: pin, reorder, unpin, reload).
