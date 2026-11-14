---
row: U05
---

Design review 13 November I18/I19: a right-click over stacked targets opens
the top target's menu led by "Select other ▸" (`aria-haspopup="menu"`, with
its Alt+↓ key), a target chosen from that list reopens its own menu, and
Shift+F10 or the Menu key opens the selection's menu without re-picking. A
face's menu carries the face verbs the verb rail shows (Push/pull, Sketch on
face, Hole…, with each disabled verb's reason) and Look at face; Union and
Subtract say why they are off. Panel headers answer a right-click with Pin,
Pop out, the Move targets and Close. The Select other list follows the
chrome's light or dark theme (`apps/web/src/lib/viewportMenu.ts`,
`viewportMenu.test.ts`, `PanelFrame.test.tsx`, `ContextMenu.test.tsx`,
`test/e2e/visual-selection-pick-list.spec.ts`).
