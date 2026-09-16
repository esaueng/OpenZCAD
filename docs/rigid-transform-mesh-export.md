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

OpenZCAD pins `325c5bc3`, the remus#474 head build (v2.130.22-era
packages). The fix's squash merge on remus main (`49567b02`, v2.130.23)
ships packages built with simd128 enabled by default, and the 4-lane
homogeneous contraction from remus#470 rounds the transform path
differently enough that the carried certificate undershoots again — the
real project and the synthetic fixture below both fail there with the
identical residual excess the patch fixes on scalar builds
([remus#483](https://github.com/esaueng/remus/issues/483)). The pin moves
to a fixed mainline build once remus#483 is resolved. The remus#480
backport to the previous baseline also fixes the case but was superseded:
this pin keeps the newer kernel line and its adapted measurement,
partial-revolve and parity characterizations.

`test/saved-project-export.test.ts` includes an always-on synthetic cylinder
whose tolerance lies at this numerical boundary. It fails on the previous
kernel, then passes serialization, binary STL export and 3MF export/reimport
with the fix. Both writers must still reject a deliberately enlarged gap.

The same test file accepts a private saved-project copy through
`OPENZCAD_EXPORT_PROJECT_COPY` for full document replay and export checks.
Private source data is not committed. This opt-in test is additional local
evidence; the synthetic regression runs in CI without private files.
