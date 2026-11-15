---
row: AS04
state: Partial
---

Pairwise interference slice (no schema change; a read-only query on schema
v61): Assemble's sidebar gains an Interference section whose Check runs an
exact pairwise check of every pair of components at their solved pose (never
the exploded view) in the geometry worker. It is M09's body clash query
(`packages/kernel-adapter/src/exact-body-clash.ts`) run on posed copies, so
AS04 and M09 share one implementation and there is no second engine or mesh
test: disjoint boxes prove clearance; the kernel's exact intersection
measures shared volume, and where Remus 1.141 declines an intersection it
cannot build (a pin in a clearance hole) its exact difference measures it as
`volume(b) − volume(b − a)`. Each overlap carries witnesses (exact volume,
the shared region's box, a point both exact classifiers place strictly inside
both parts); clearance carries the certified distance and closest points
where the kernel certifies them, zero being contact; a pair no boolean
answers is reported unknown with the kernel's refusal, never clear, and a
component whose body is gone is listed as unchecked. Picking a pair picks
both parts and shows its witness; a result says "Out of date" once the model
or poses change. Contract: docs/plans/assemblies-plan.md (Interference).
Evidence: `packages/kernel-adapter/src/exact-body-clash.test.ts` (overlapping
boxes, face contact, certified gap, pin in a clearance hole, line-to-line
fit, off-axis pin, sphere in a box face, multi-solid bodies, pair order,
verdict combination), `test/assembly-interference.test.ts` (real-kernel
document check: volumes, witnesses, distances, exploded view ignored, a
rotated component, a missing body, ordering),
`apps/web/src/lib/assembly/interferenceUi.test.ts`,
`AssemblyInterferenceSection.test.tsx` and the CI smoke case
`test/e2e/assembly-interference.spec.ts` (2880 mm³ overlap with its witness,
pin clear, out of date after turning a joint, re-check). The STEP hierarchy
round-trip in this row remains open; interference swept through motion is a
follow-up.
