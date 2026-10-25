---
row: U09
---

Phase 6, primitives in place: Box, Cylinder, Cone, Sphere and Torus open no
card. The command previews the card's default at the origin at once, so Enter
alone still makes it; a press-drag on the ground (or the upright principal
plane facing an edge-on view) or on a flat face draws the footprint, a box's
rectangle corner to corner and a round primitive's circle from its centre;
the sizes are linear handles with chips, the height an arrow off the plane;
the exact position (corner, base center or center) is typed from the bar's
Options. On a face square to an axis a box stays unturned; a round primitive
on a side face, or anything on a tilted face, turns in the same placement
Move. Commits go through the card's own `createPrimitiveCommand`
(`primitives.test.ts`, `tools.test.ts`, `useInPlaceCommand.test.tsx`,
`InPlaceCommandBar.test.tsx`, `primitivePlacement.test.ts`,
`test/e2e/in-place-primitives.spec.ts`; the e2e suite places primitives
through `createPrimitiveInPlace`). Editing a primitive from History still
opens its card.
