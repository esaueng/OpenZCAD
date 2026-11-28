---
row: M04
---

Exact helical sweep corrections (#2188, #2120, #2190, #2191, #2119, #2189):
the adapter tests the profile against its own copy one pitch along the axis,
curve against curve in the plane the screw keeps (bounded subdivision over
every boundary curve, ends included), and refuses a coil of a full turn or
more whose turns would overlap or touch before the kernel is asked; the
kernel's own check reads the profile's height from sampled points and let a
one-turn Ø3 mm coil through at a 2.997 mm pitch with its end caps
overlapping. A slanted profile is held to its longest line along the axis,
not its height, and 0.99999999 of a turn is not a turn
(`exact-helical-clearance.ts`, `test/helical-sweep-clearance.test.ts` on the
real kernel, with a STEP round trip of the coils that build). The kernel
still refuses by height: a slanted profile that clears itself at a pitch
under its height is refused there, not here. The refusal reads "The coils would overlap…"
with the controls that clear it. History as text and an `update_feature`
patch refuse a new `radius` for a coil wound in place, where it builds
nothing, and say what moves the coil; a faceted helix still takes one. That
coil no longer reads its recorded radius, so one naming a deleted parameter
rebuilds, and the same edits may replace it. The Turns handle rides the
coil's end down the axis when the pitch runs against it. In
the Options panel a number typed over its rounded display is applied (1 over
a held 1.001 turns), the Height/Pitch switch keeps a pitch that runs against
the axis, and a coil saved growing down reopens on Down
(`test/e2e/exact-sweeps.spec.ts`).
