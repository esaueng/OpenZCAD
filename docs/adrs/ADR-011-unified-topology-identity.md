# ADR-011: Unified Cross-Kernel Topology Identity

## Status

Accepted. Amends ADR-008 (which allowed traversal ordinals as topology
references) and the persistence half of ADR-010.

## Context

OpenZCAD builds every document on one of two exact kernels: BrepKit normally,
OpenCascade whenever the document contains a STEP import. Adding or removing a
STEP feature therefore reroutes the *entire* document between kernels, and any
persisted topology reference — fillet/chamfer edge hashes, direct-edit face
hashes — must resolve identically on both. Before this ADR, BrepKit persisted
geometric fingerprints while OpenCascade persisted 1-based traversal ordinals
and resolved them positionally. An upstream edit that shifted enumeration made
a fillet silently land on different edges; a kernel reroute made every
reference unresolvable or, worse, positionally misread.

## Decision

Both kernels persist face and edge references as FNV-1a (offset basis
2166136261, prime 16777619, zero mapped to 1) hashes of signature strings
built by `packages/kernel-adapter/src/topology-fingerprint.ts`. Signature
inputs are exclusively exact geometric quantities that both kernels agree on
after quantization; tessellated measurements, traversal ordinals, and
parameterization-phase-dependent samples are banned, because kernels seam and
phase closed curves differently and tessellate at different densities.

### What is fingerprinted

- **Open edges** — curve class (BrepKit's vocabulary: `LINE`, `CIRCLE`,
  `ELLIPSE`, `BSPLINE_CURVE`), exact curve length, the two endpoint vertex
  positions sorted lexicographically, and the mid-parameter point (which is
  reversal-invariant for open curves). This is byte-identical to the scheme
  BrepKit has always persisted, so existing open-edge references keep their
  values.
- **Closed edges** — curve class, exact length, the mean of four samples
  equally spaced across the parameter domain (exactly the centre for circles
  and ellipses, independent of seam and phase), and the canonicalized curve
  plane normal derived from two tangents a quarter-domain apart.
- **Faces** — surface class, the summed length of the unique boundary edges
  (exact on both kernels, unlike tessellated area), the mean of the unique
  boundary vertex positions, and canonical analytic parameters where both
  kernels can read them exactly: planes as sign-canonical (normal, offset),
  cylinders as canonical axis + axis foot + radius. Other surface classes
  (sphere, cone, torus, bspline) carry no analytic term and rely on
  perimeter + centroid; coincident twins fail closed as ambiguous.

### Quantization

Coordinates and lengths quantize by rounding at `GEOMETRY_LINEAR_TOLERANCE`
(1e-6 document units); direction components quantize 1000× finer. Closedness
itself is decided by quantized endpoint coincidence so both kernels agree.

### Resolution is fail-closed

A reference resolves only when exactly one sub-shape carries the hash. Zero
matches raise "no longer exists"; multiple matches raise "geometrically
ambiguous". A missed resolution can never select a nearby or positional
substitute.

### Cross-kernel guarantees and limits

The construction paths guarantee equal fingerprints across kernels for
analytic geometry built from the same feature history: primitives, sketch
extrudes/revolves (including detected-region extrudes with holes — the
OpenCascade adapter subdivides region arcs exactly as BrepKit does and rotates
full-circle seams a quarter turn to land on BrepKit's seam vertex), booleans
of these, and transforms. Covered by round-trip tests in
`test/kernel-seam.test.ts`.

Not guaranteed cross-kernel: closed B-spline edges (no phase-invariant sample
exists) and the NURBS blend boundaries produced by BrepKit fillets (OpenCascade
represents blends analytically). References to such topology resolve within
the kernel that created them and otherwise fail closed — never silently remap.

### Legacy references

- **BrepKit documents** predating this ADR hold the old scheme's hashes:
  seam/phase-dependent closed-edge signatures and tessellated-area face
  signatures. The BrepKit adapter registers both generations in its resolution
  maps, so old references keep resolving; newly persisted topology always
  carries the unified hash.
- **OpenCascade documents** predating this ADR hold 1-based traversal
  ordinals. These are rejected, never migrated: an ordinal names a position,
  not geometry, and the enumeration that gave it meaning cannot be
  reconstructed safely. When an unresolved hash lies in `[1, subshape count]`
  the error says the feature was saved by an older version and must be
  re-created from a fresh selection. Silent positional interpretation is the
  one unacceptable outcome.

## Consequences

- A fillet survives adding or removing STEP imports and upstream edits that
  shift edge enumeration, or fails visibly; it can no longer change edges
  silently.
- Region extrudes build the same solid — holes included — on both kernels, and
  a region that cannot be resolved fails with the owning feature named.
- Viewport topology IDs (`face:<hash>` / `edge:<hash>`) are stable across
  kernels, so selections keep meaning through a reroute.
- Face hashes changed value for all BrepKit documents (area → perimeter);
  this is invisible to users because legacy hashes still resolve, but any
  external system that recorded hash values must re-read them.
- Both adapters spend extra work per rebuild computing fingerprints for
  resolution maps; the cost is linear in sub-shape count and has not been
  measurable next to tessellation.
