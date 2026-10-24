---
row: U08
---
Docked columns fill the dock by default again (Fit panels to content is
opt-in, stored as `hug` so the old default-on `fit` key no longer applies);
a handle under each docked column sets its height (drag, arrow keys, End or
a double-click to fill), remembered per set of panels, so a second panel in
a shortened column fills the dock and taking it out restores the height
(`panel-layout.test.ts`, `panel-dock.spec.ts`).
