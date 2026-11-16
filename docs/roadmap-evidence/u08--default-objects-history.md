---
row: U08
---

Fresh devices start with Objects above History, both pinned in one right-hand
column. Objects fits its contents and History uses the remaining height through
the existing sizing rule. Saved layouts, named presets, legacy drawer migration
and the responsive phone lane retain their behavior. Coverage:
`test/panel-layout.test.ts` and the tagged fresh-device cases in
`test/e2e/panel-dock.spec.ts` (1440px and 1024px, model creation, reload and a
saved choice to close History).
The first-model tour teaches History while it is already open and still points
to its rail button when a saved layout has it closed; both paths run in the
tagged cases in `test/e2e/workspace-tour.spec.ts`.
