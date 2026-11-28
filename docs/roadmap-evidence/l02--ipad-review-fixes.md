---
row: L02
---

iPad review fixes (iPad Pro 11-inch simulator UI/UX pass on the regular workspace): the first-run guide stands aside while the exact-entry keypad is up (`viewerResponsiveContracts.test.ts`); a touch on the keypad's field folds its keys away for the system keyboard, and the keypad never rises under the top bar (`NumericKeypad.test.tsx`); a typed value whose preview hides the pick, or only resizes the keypad, keeps it where it stands (`keypad.test.ts`, `NumericKeypad.test.tsx`); History rows and panel titles read in a panel under 260 px and 200 px wide, as an iPad at its largest text size lays them out; the opening fit follows the stage under the workspace cover, so a demo opened second in a session is framed clear of the panels (`fitFrame.test.ts`); the sketch rail and Finish are 44 px on a tablet, in two columns where one would not fit; and file pickers on iPad and iPhone open Files directly, with every file selectable (`appleTouch.test.ts`).
