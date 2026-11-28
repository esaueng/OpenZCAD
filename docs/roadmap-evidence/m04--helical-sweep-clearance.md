---
row: M04
---

Exact helical sweep corrections (#2188, #2120, #2190, #2191, #2119, #2189):
the adapter measures the profile's span under the screw from the profile's
own curves, each extreme refined on its curve, and refuses coils that would
overlap or touch before the kernel is asked; the kernel's own check reads 48
points per curve and let a one-turn Ø3 mm coil through at a 2.997 mm pitch
with its end caps overlapping (`exact-helical-clearance.ts`,
`test/helical-sweep-clearance.test.ts` on the real kernel, with a STEP round
trip of the coils that build). The refusal reads "The coils would overlap…"
with the controls that clear it. History as text and an `update_feature`
patch refuse a new `radius` for a coil wound in place, where it builds
nothing, and say what moves the coil; a faceted helix still takes one. In
the Options panel a number typed over its rounded display is applied (1 over
a held 1.001 turns), the Height/Pitch switch keeps a pitch that runs against
the axis, and a coil saved growing down reopens on Down
(`test/e2e/exact-sweeps.spec.ts`).
