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

The original failure was reproduced on Remus `49567b02` (v2.130.23): the
complete saved history reaches arena edge 224 with an end residual of
`0.00004459513151899178 mm`, just above its carried
`0.00004459513151817844 mm` tolerance. OpenZCAD first held a scalar
pre-SIMD build while [remus#483](https://github.com/esaueng/remus/issues/483)
was repaired. The current paired `remus-wasm` and `remus-wasm-io` pin retains
the bounded certificate carry and passes the same complete-history replay.

`test/saved-project-export.test.ts` includes an always-on synthetic cylinder
whose tolerance lies at this numerical boundary. It fails on the previous
kernel, then passes serialization, binary STL export and 3MF export/reimport
with the fix. Both writers must still reject a deliberately enlarged gap.

The same test file accepts a private saved-project copy through
`OPENZCAD_EXPORT_PROJECT_COPY` for full document replay and export checks.
That replay asserts the saved millimetre unit, valid reimported exact solids,
closed and consistently oriented STL/3MF topology, the 3MF's declared
millimetre unit, and mesh-volume agreement with the exact export. Private
source data is not committed. This opt-in test is additional local evidence;
the synthetic regression runs in CI without private files.

The replay also exposed two exact zero-area facets from a collapsed seam.
`mesh-export-sanitize.ts` removes only triangles whose emitted cross product
is exactly zero (and refuses non-finite coordinates) from binary STL and 3MF;
the ASCII STL writer applies the same rule. It does not weld or move vertices,
change tessellation deflection, relax topology validation, or alter the exact
B-rep. [Remus #520](https://github.com/esaueng/remus/pull/520) carries the same
filter into the shared writers so the adapter guard becomes a no-op after the
paired WASM packages advance.
