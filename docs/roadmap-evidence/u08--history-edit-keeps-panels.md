---
row: U08
---
Editing an existing feature from History or Objects no longer suspends the
model panels; only creation commands and sketches do (`commandSuspendsPanels`,
`test/panel-state.test.ts`, `design-review-fixes.spec.ts`). Edit cards name
their History step, put Cancel before Apply as the in-place bar does, explain
an unchanged edit and point an in-place edit at its bar (`Inspector.test.tsx`,
`PrimitiveForm.test.tsx`).
