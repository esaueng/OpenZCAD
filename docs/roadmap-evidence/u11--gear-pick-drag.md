---
row: U11
---

Gear, third tool (no schema change). A new gear's teeth drag on the gear
itself. One arrow runs from the gear's centre, and its head stands on the
pitch circle, half a module out per tooth. Dragging it out or in adds or
removes teeth at the same module, so the gear grows or shrinks, as the
coil-end ball winds turns at the same spacing. The drag lands on whole
teeth. The face-width arrow is the second drag, and the pitch stays a chip.
Spur, helical, ring, bevel and worm-wheel gears take the arrow. A worm's
count is its starts and a rack has no circle, so those keep their chips.
Gear teeth on a boss or bore keep their one pick and their length arrow,
which is shared with Thread. Options now reads out what the face decides, as
Thread's does ("Sized from the Ø22 mm face · Teeth run 4 of 6 mm"). With
Set module, the module and pitch circle come first. Command handles take an
optional drag step, so a count's arrow rests where its value does. Evidence:
`tools.test.ts` (the arrow's scale for each sizing, the types that take it,
the readout before and after a drag), `panel.test.ts`, and
`test/e2e/gear.spec.ts`. Its `@ci-smoke` case picks the box's top, checks
the arrow head on the Ø40 pitch circle, drags it to 24 teeth and the face
width down to about 6, reads "Module 2 mm · Pitch Ø 48 mm" in Options, and
writes an untouched History edit back unchanged. The Gear teeth case picks a
boss and reads the face's readout. It then drags the arrow short and checks
the stored length.
