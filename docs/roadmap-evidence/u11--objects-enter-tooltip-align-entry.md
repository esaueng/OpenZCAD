---
row: U11
---

Three selection and input fixes. Enter on an Objects row reached by keyboard
picks that row as Space does, over an armed face pick and during a Boolean's
or Mirror's body picks, and runs no Done and opens no value entry; a row
focused or clicked by a pointer leaves Enter to the command, as a clicked rail
tool does. How focus arrived is read from the window's most recent input, so a
mouse press abandoned off the list changes nothing, and a held Enter acts once
(`apps/web/src/lib/keyboardRowEnter.ts`, `ObjectsPanel.test.tsx`,
`test/e2e/objects-row-enter.spec.ts`). The touch Multi-select help now says
what the keys do: on the model only Shift (and the toggle) add face, edge and
body picks, Ctrl/⌘ reach only sketch entities and profiles, and in Objects
they add body and folder rows (`ViewerToolbar.test.tsx`). A command chip's
editor and keypad close, as if canceled, once every pick they were opened over
is taken back and the chip goes with them, so Align's Offset editor no longer
stays open after a click on the moving face clears the pair, and the first
Escape closes Align; a pick replaced, as a Circular Pattern's source body,
keeps the draft (`apps/web/src/lib/inPlace/chipEntrySlots.ts`,
`chipEntrySlots.test.ts`, untagged case in `test/e2e/face-align.spec.ts`).
