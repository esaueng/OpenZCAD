---
row: U09
---

Phases 2–5: Loft, Sweep, Helical sweep, Hole, Shell, Thicken, Solid offset,
Draft, Mirror, Split, Scale, Rotate about axis, Union, Subtract, Intersect and
the linear, circular and grid patterns run in place through one command table
(`apps/web/src/lib/inPlace/tools.ts`) and one hook
(`apps/web/src/hooks/useInPlaceCommand.ts`). Picks are region, curve, face,
body and plane clicks (a box sweep fills Shell and Draft); numbers are linear,
angle and chip handles with keypad entry; rare choices sit behind the bar's
Options menu; Done waits for an exact preview of exactly what it commits
(`tools.test.ts`, `useInPlaceCommand.test.tsx`, `linearRig.test.ts`,
`curvePickerRig.test.ts`, `test/e2e/in-place-sketch-tools.spec.ts`,
`test/e2e/in-place-face-tools.spec.ts`). Primitives, Plane, Axis, Image and
Fillet/Chamfer still open their cards.
