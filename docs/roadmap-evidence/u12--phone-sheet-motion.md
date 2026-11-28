---
row: U12
---

Phone sheet motion (the owner's refinement pass and a Sol motion review on the iPhone simulator): pulling Build's row up draws All tools under it as the sheet follows the finger, its head and then its tiles in reading order, and pulling a page over a tray-only sheet back down shows the row through it and puts the page away at peek (`BottomSheet.test.tsx`, `CompactAppShell.test.tsx`); pages slide in when pushed and back when popped, All tools' tiles come in staggered, and Reduce Motion fades instead; a page swiped from its leading edge goes back; a row with nothing under it (View's, Tweak's, Draw's tray alone) stretches and springs back rather than rising over blank space (`CompactModeTray.test.tsx`); a text field tapped on a page at peek brings the sheet to half; the pick's page goes when the pick clears under it; the mode tabs dim while a full-height sheet makes them inert; and a new mode's tray rises into the row.
