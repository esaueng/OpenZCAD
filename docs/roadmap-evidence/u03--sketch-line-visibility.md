---
row: U03
---
Active and finished sketch curves use 2.2 CSS-pixel strokes and bypass solid
tone mapping so their state colours remain saturated on model faces; finished
ordinary curves retain full opacity. Selected curves remain heavier and
construction dashes/colour and depth-tested occlusion remain intact.
`sketch-transition-continuity.spec.ts` draws and finishes a circle, measures its
rendered blue stroke over the face, and checks camera and body-depth continuity
through the rebuild in normal and reduced motion. No geometry, picking
tolerances or persisted sketch bases change.
