---
row: U03
---

12 November review follow-up: a temporary (unpinned or revealed) panel no
longer hides a pinned one. Where the stage has no room for another column it
is drawn under the pinned panels in their column, which stay interactive with
their rail buttons pressed and get the room back when it closes; the footer
notice and its duplicate Pin are replaced by the header Pin's tooltip. The
rail's "View options" is renamed "Panel layout" and its menu keeps a margin
from the window's foot. The parameter type picker shows a readable glyph and
chevron, and its amber state (a unitless parameter whose uses all expect one
quantity) is explained in its tooltip, its accessible description and the
option list. Coverage: `test/panel-layout.test.ts`,
`ModelPanel.test.tsx`, `ViewOptionsMenu.test.tsx`, `ParameterRows.test.tsx`,
and `deep-design-polish.spec.ts`, `panel-dock.spec.ts`,
`panel-view-options.spec.ts` in the browser.
