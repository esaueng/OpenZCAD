---
row: U03
---
View-cube orbit cost: the viewer now paints the cube into its own WebGL
canvas (`orientationCubeOverlay.ts`), and the SVG stays as the unpainted
click/focus/accessibility layer, refreshed when the camera rests or a pointer
reaches it. An orbit no longer rewrites ~40 SVG attributes per frame, which
made Firefox repaint the page every frame and cost orbits ~25% of their frames
under CPU contention. Parity with the SVG cube was checked at DPR 2 across
seven states (mean pixel difference under 1/255). Covered by
`OrientationWidget.test.tsx`, `orientationCubeOverlay.test.ts` and
`viewport.spec.ts` ("an orbit draws the view cube without touching the page").
