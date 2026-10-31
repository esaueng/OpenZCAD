---
row: S06
---
Face-on sketch entry preserves the chosen view instead of rolling to the stored
plane axes; exit restores the visible screen-up along with position, target and
projection. Oblique entries retain plane-axis alignment and stored sketch bases
are unchanged. Sketch body fades now update blending, depth and stencil together
and restore an existing translucent appearance correctly. Regression evidence:
`sketchCamera.test.ts`, `SelectionManager.test.ts`, and the frame-sampled
`sketch-transition-continuity.spec.ts` in normal/reduced motion, alongside the
existing seven `sketch-face-orientation.spec.ts` cases. Browser verification uses
the production renderer. This is a bounded S06 slice, not completion of the row.
