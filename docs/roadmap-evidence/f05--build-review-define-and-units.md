---
row: F05
---

13 November design review, Build entry (I25, I33 and the parameter parts of
I11): a name no parameter defines yet is offered for definition in place
from the numeric keypad and from a command's Options rows too, not only
from an expression field ("foo is not defined yet · Define foo = [30]");
defined, the keypad previews the entry and an Options row applies it. While
either entry does not evaluate, Done waits instead of applying the value
held, and an Options row says why it was not applied. The keypad readout
names the unit once ("= 30" beside its unit, no longer "= 30 mm mm"). A new
parameter whose expression states a unit takes that quantity (`width =
40 mm` is a length, no longer a unitless 40); the status lane says a refused
new name "was not added" rather than "was not changed", reports a taken
name the add row refuses, and the expression cell grows to show `width / 2`
where the field can size to its content. Coverage: `NumericKeypad.test.tsx`,
`InPlaceCommandBar.test.tsx`, `ParameterRows.focus.test.tsx`,
`parameterQuantity.test.ts`.
