---
row: U10
---

View cube help names the orbit mode: hovering the cube shows "Free orbit" or
"Turntable orbit" with the key that switches it (Shift+O, or its remap) and
what a drag does in that mode, and follows the mode as it changes. Pressing
the cube closes the help so it never covers a drag; it replaces the cube's
native SVG title, whose name the toolbar keeps as its `aria-label`
(`OrientationWidget.test.tsx`, `test/e2e/view-cube-orbit-tooltip.spec.ts`).
