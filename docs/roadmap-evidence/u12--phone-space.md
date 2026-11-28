---
row: U12
---

Phone space review fixes: the sheet at peek is its row under a 12px grip (a 44px grabber band behind the row; the Close that did nothing at peek is gone), saving 40px of stage in every mode (`BottomSheet.test.tsx`); the keypad's Backspace is a tall fifth column; a region's Extrude card gives way to the keypad; opening a sheet or tray page never focuses a text field (`CompactDrawTray.test.tsx`); the landscape side sheet drops its stage-side safe-area inset. Compact e2e: plane taps wait for the sheet to settle, and the long-press test holds a face found near its point.
