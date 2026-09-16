# Mesh export after rigid STEP placement

STL and 3MF export pass exact solids between the kernel and the file-format
module through the serialized arena. That handoff validates each curved
edge's endpoints against its recorded tolerance. The viewport can display
an in-memory solid even when this later handoff refuses it.

A STEP edge can arrive with its tolerance equal to its measured endpoint
residual. A rotation with translation can then round the vertex and curve
frame independently, leaving the residual a few floating-point steps above
that tolerance. The source fix in [Remus #474](https://github.com/esaueng/remus/pull/474)
carries the existing endpoint certificate through the rigid transform within
the bounded roundoff allowance. It does not bypass the export validator or
permit meaningful geometric gaps.

OpenZCAD consumes that fix on the mainline kernel pin (`49567b02`,
v2.130.23, the remus#474 squash merge). An earlier backport of the same
patch to the previous baseline (remus#480) was superseded when the mainline
pin landed with the measurement and partial-revolve adaptations that came
with it.

`test/saved-project-export.test.ts` includes an always-on synthetic cylinder
whose tolerance lies at this numerical boundary. It fails on the previous
kernel, then passes serialization, binary STL export and 3MF export/reimport
with the fix. Both writers must still reject a deliberately enlarged gap.

The same test file accepts a private saved-project copy through
`OPENZCAD_EXPORT_PROJECT_COPY` for full document replay and export checks.
Private source data is not committed. This opt-in test is additional local
evidence; the synthetic regression runs in CI without private files.
