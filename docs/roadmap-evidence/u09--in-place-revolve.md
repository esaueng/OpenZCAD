---
row: U09
state: Partial
---

Phase 1, Revolve in place: no card; the profile is a region click, the axis a
click on one of the drawn sketch or datum axis lines, the angle a drag of the
new angle rig (`packages/viewport/src/gizmo/angleRig.ts`) or its chip's keypad,
with an exact preview through the commit's own command and a Cancel / Done bar
in the guidance row. Schema v38 adds the revolve's region `profile`, so a
rectangle drawn as four edges revolves (`test/region-revolve.test.ts`,
`useInPlaceRevolve.test.tsx`, `angleRig.test.ts`, `axisPickerRig.test.ts`,
`InPlaceCommandBar.test.tsx`, `test/e2e/in-place-revolve.spec.ts`).
