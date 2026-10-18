# Interactive edit sessions (H02 / W02)

Face dragging now requests a disposable mesh with `topology: 'pending'`.
The exact operation, recorded-face identity guards, analytic-carrier census,
B-rep validation, import diagnostics and strict union closure gates still run.
Display face ranges and analytic dimensions keep the dragged highlight current;
edge topology, output references and recognition remain deferred. Picking stays
suspended until complete topology arrives. Only output naming
for a terminal planar face offset is deferred; its separate history digest
forces normal replay before a commit, downstream operation or export can use
that result. Ordinary `previewGeometry` callers retain complete topology.

The display path retains the existing held-deflection policy, consumes owned
WASM arrays once and avoids concatenating a single solid's buffers. It can
consume the strict union gate's same-sync mesh and closure proof only when
kernel, solid handle and both tessellation deflections match. Compound meshes
still require their combined closure check. Welding and winding checks use
the same tolerances; indexed vertices are quantized once and edge keys use
canonical numeric vertex pairs instead of repeated coordinate strings.

Parameter editing prepares the recognized construction, baseline parameter
scope and structural guard once. A tick compares immutable STEP strings
exactly instead of serializing or hashing their full contents, then updates
matrices over retained source meshes. The recognized lettering body's verified
placement transforms participate too. Previously those post-import transforms
were mistaken for unsupported consumers, disabling the whole holder preview.
The viewport continues to label this display as a parameter preview; it is
never persisted or exported as an exact solid. Unsupported consumers, changed
structure/source/units, invalid expressions and minimum violations still
decline the approximation.

The retained exact arena also reuses successful immutable intersections and
transforms within an audited suffix. Each entry requires the full feature
digest and identical exact operand handles, lineage and mesh/revolve flags.
Only shape updates and monotonic consumption/origin additions are cached;
warnings, repairs or other build-state changes disqualify it. There is one
latest value per feature, at most 64 entries, with invalidation on restore,
project changes, disposal and ordinary arena recycling. Changed operands replay
normally. Unions retain their existing acceptance path. No post-interval
checkpoint is restored to resurrect a cached branch, so the separately
proposed H02 private Text-branch cache remains blocked as documented.

The existing 32-checkpoint, 128 MiB estimated admission and 512 executed-builder
budgets are unchanged. Admission estimates and allocated WASM pages are not a
process-memory ceiling. A cold rebuild after recycling remains visible in
tail latency.

## Qualification

The baseline and candidate use the same paired Remus `2026.1.65` packages at
`9add24f1b10cd5f5ae7f502b06e80e5eb5ba15c5`, without kernel or tolerance changes.
The public `crates/io/tests/data/shapr3d_hammer_holder.step` in that revision
has SHA-256 `2403b4c9868cbb56292a09ec2f2d37baca16cc4b789d11e97ff8df3f1e46bef8`:
160 faces, 386 edges, including 42 NURBS, 42 cylinders, 14 tori and 8 spheres.
The direct workflow offsets the outer +X arm face in both directions. The
parameter workflow changes the opening of its recognized, lettered holder
construction around 46 mm.

Measurements distinguish matrix preview preparation, candidate-document
creation, exact mesh publication, and completed analysis. Worker timings
exclude main-thread packing, transfer, GPU upload and display presentation.
Real-app checks separately exercise repeated parameter input, exact face
dragging/cancel, release, selection and deferred-analysis behavior in Chromium
with SwiftShader. These are workstation results on one model, not a universal
60 fps or target-device guarantee.

Regression coverage includes fresh-build numerical/topology equivalence,
changed operands and restored handles, lettered previews, source/structure
invalidation, pending topology, normal release metadata, owned mesh buffers,
display-quality matching, duplicated face seams, closed/open/nonmanifold meshes
and winding. The complex part also retains its exact carrier/radius census
and closed mesh for inward/outward edits; reversed parameter edits restore
volume and match independent fresh rebuilds.
