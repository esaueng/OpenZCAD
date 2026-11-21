---
row: U11
---

Booleans, fourth tool (no schema change). Union, Subtract and Intersect are
picked in the model alone, and each body they take is named where it stands
by its role: Base from the first click, Tool after. These are the names
Options lists, where the bodies used to wear pick numbers and one pick wore
only its name. A Tool that the preview has consumed, such as a subtract's,
is still named where it was picked, at the box it was picked with, so every
input stays findable while the result shows. Options' Remove takes a Tool
back out. Picked again in the model, it is named Tool again. A boolean has
no value to drag, so its picks are the whole interaction. Evidence:
`booleanSwitch.test.ts` (roles by pick order, with each pick's name and
box). `test/e2e/boolean-selection.spec.ts` (`@ci-smoke`) clicks two
overlapping cubes in the model. It checks Base and Tool on the bodies and
in Options, removes and re-picks the Tool, and checks that the Tool is
still named once the preview consumed it. It then subtracts to 750 mm³.
`solid-result-options.spec.ts` still passes.
