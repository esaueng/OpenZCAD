---
row: U05
---

Design review 13 November I20/I21 and the command-bar part of I24: the
command bar answers to the chrome's own names ("help", "shortcuts",
"keyboard" open Help & keyboard shortcuts; Rename project and Duplicate
project; "home" and "new project" find Back to projects; Switch to Assemble
mode joins the mode switches); Ctrl+K and ArrowDown in the empty field list
the commands that run here; a search that finds nothing says how to list
every command or find the shortcuts; a disabled best match is never the row
Enter or Tab takes. Ctrl/Cmd+Shift+M is "Next workspace mode", stepping
through all five modes, and only the mode it goes to next shows the key in
its tooltip. Help & controls writes chords as the rest of the workspace does
("Ctrl+S", "Shift+Click"); support exports are grouped under Support; the
File menu's Import project… carries its ellipsis; the readout's instructions
toggle is an "i", not a second Help (`CommandBar.test.tsx`,
`ShortcutsOverlay.test.tsx`, `topBarPresentation.test.ts`,
`test/control-reference.test.ts`, `test/e2e/command-bar-names.spec.ts`).
