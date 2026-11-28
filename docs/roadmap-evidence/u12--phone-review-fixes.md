---
row: U12
---

Phone review fixes (iPhone simulator UI/UX pass on the TestFlight build): a region's Extrude opens the sheet at peek so its arrow and value stay in view (`CompactAppShell.test.tsx`); the Pipe Flange demo chamfers its rims by lineage reference before the bolt circle, so Tweak's Rim r step rebuilds (`test/demo-parameter-tweaks.test.ts`); the iOS text size zooms the iPhone and iPad workspace, capped at 1.5 and a 320 CSS px page (`WorkspaceIdiomTests.swift`); a keypad key replaces the field's selected value (`keypad.test.ts`, `NumericKeypad.test.tsx`); a command bar remounted with an earlier draft stays closed (`CommandBar.test.tsx`); the native keyboard resizes the web view rather than scrolling the page under the status bar; and the empty Shared tab says what Shared holds (`StartScreen.compact.test.tsx`).
