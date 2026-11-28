---
row: M13
---

Kept measurements are kept through copies, conversions and lost targets.
Duplicate and Convert a copy copy the source's measurement record to the copy
as stored, unresolved rows and unreadable fields included, under the copy's
id (`copyProjectMeasurements`, `apps/web/src/lib/localProjectStore.test.ts`).
A stored-unit conversion re-attaches each kept target to the scaled entity:
a named one by the kernel re-capture's witness rule, an unnamed Boolean face
or edge from the bodies it was last measured on, by the geometry oracle's
per-face rule and its edge counterpart, now shared from
`packages/kernel-adapter/src/units-witness-match.ts`
(`test/measurement-stored-units.test.ts` covers a face pair, a snapped edge
midpoint and a maximum distance on a Boolean result;
`apps/web/src/hooks/useMeasurementWorkbench.test.tsx`). Each target keeps
its identity with the unit it was captured in (`identityUnit`): a hash
resolves directly only in that unit, so an undo or a body that returns in
it recovers the row, and across units a target rebinds only by a unique
scaled match, its own witness first. A row that cannot be
re-measured keeps `sourceRevision`, the revision that produced its number,
and records the attempt in `checkedRevision` (CSV `checked_revision`); it
drops its viewport callout at once, as a reopened project already did
(`test/measurement-refresh.test.ts`). A circle exported as a radius is filed
under `kind=radius` (`test/measurements.test.ts`).
