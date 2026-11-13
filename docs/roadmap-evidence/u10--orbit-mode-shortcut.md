---
row: U10
---

Orbit mode shortcut and button: Shift+O (remappable, "Toggle orbit mode"), the
command bar's "Orbit: switch to …" row and an Orbit mode button on the viewer
bar (pressed in Turntable, "Now:" naming the mode) flip the orbit preference
between Free and Turntable. All three change the same account setting as
Settings → Controls → Orbit. The button leaves the bar only in the window
heights where it would push the bar past the window's foot (≤540px, touch
≤611px, a one-column mouse rail 601–638px), where Shift+O and the command bar
still switch it (`apps/web/src/lib/keymap.ts`, `ViewerToolbar.test.tsx`,
`test/e2e/orbit-mode-setting.spec.ts`, `design-review-followups.spec.ts`).
