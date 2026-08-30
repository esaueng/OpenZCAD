# Kernel roadmap: Remus in OpenZCAD (2026-08-29)

**Scope.** What to do next on the kernel — and on OpenZCAD's use of it — to make
this the most stable, most capable open-source web-based CAD application of its
kind. Drafted from a full review of the pinned Remus checkout (`remus-wasm`
v2.130.0, `esaueng/remus` @ `7918b45`), the adapter in
`packages/kernel-adapter`, the parity corpus, and both repos' planning docs.

**Relationship to other documents.** Remus has its own kernel-side program:
[`docs/kernel-maturity/p-class-program.md`](https://github.com/esaueng/remus/blob/main/docs/kernel-maturity/p-class-program.md)
(drafted 2026-08-28, "Parasolid-class", milestones M2–M8, ~45 issues, 2 landed).
This document does not duplicate it. It is the **consumer-driven complement**:
which of those milestones OpenZCAD actually needs first, which defects and gaps
the app has measured that the kernel program does not yet own, and the
web-platform and open-source work that belongs to neither existing plan.
`docs/kernel-roadmap.md` and `docs/kernel-execution-plan.md` are BrepKit-era
historical records and stay that way; `TODO.md` remains the product roadmap,
and [cad-feature-roadmap.md](cad-feature-roadmap.md) is the product-level
feature companion to this document.

---

## 1. Where things stand

**The kernel's breadth phase is finished.** Every Parasolid operation family
exists, WASM-bound, with a fail-closed contract culture (typed refusals, oracle
promotion rules, census on boolean changes) that is unusually strong for an
open-source kernel. The 2026-08-21 stabilization campaign promoted draft,
defeaturing, assemblies, feature recognition, and evolution coverage to Stable
with real qualification suites. The RFC 0003 naming/evolution stack — journal,
persistent references with typed resolution, attribute propagation — is
machinery most kernels never grew, and it is fully surfaced to JavaScript.

**Three architectural pillars are missing**, per the P-Class program's own
diagnosis: general curved×curved boolean intersection (M2 — two offset unit
spheres still cannot be fused; the refusal is pinned), per-entity tolerant
modeling (M3), and sheet/wire/cellular body taxonomy (M4).

**The app trusts the kernel less than the labels suggest.** The production
adapter runs a distrust harness on every boolean (`boolean-result-validation.ts`
face-census facet-fallback detection, dropped-operand AABB checks), wraps every
modeling op in input-mutation and output-validity assertions, re-runs failed
fillets up to three times on a probe ladder just to phrase an error message,
and regex-scrapes the kernel's English refusal prose. 11 of 18 lineage
operation classes are hash-only (`topology-lineage.ts:82`), which is why a face
pick downstream of a boolean, pattern, shell, chamfer, or direct edit breaks
the moment an upstream edit perturbs its fingerprint.

**The verification story is genuinely good and should be extended, not
replaced.** The parity corpus (22 STEP files × 20 metrics × two kernels ×
closed-form references, 40 pinned divergences with enforced pin hygiene), the
kernel-seam pins, and the empty `EXPECTED_BUILD_FAILURES` / `EXPECTED_MESH_DEFECTS`
registries are the health signal to protect.

---

## 2. Track S — Stability (the "most stable" claim)

### S1. Kill the silent-wrongness class first — **highest priority overall**

These are the defects where the kernel returns a confident, valid-looking,
wrong result. Every one is measured and pinned app-side; none is fully owned by
a P-Class issue yet. Each deserves an upstream reproduction bundle and a fix
(or a typed refusal) before any capability work:

1. **`fuse` drops an operand at exact tangency** and facets a cylinder
   crossing a planar face into 70–115 planar faces. Detected today only by
   the app's AABB-containment and face-census heuristics
   (`droppedUnionOperandWarning`, `booleanFacetFallbackWarning`). Partially
   owned by P-Class 2.7 (tangency & sliver), which is marked "stretch,
   defer if pressure demands" — **the operand-loss half should not be
   deferred**; the acceptance gate added in `boolean_scale_gap` work shows
   the shape of the fix.
2. **`pattern` never fuses overlapping instances** — three overlapping
   cylinders report 11.8× the true union volume with empty warnings
   (`test/overlapping-pattern.test.ts:89`, held `it.fails`). Not in the
   P-Class program at all. File and fix upstream: fuse instances or refuse
   typed on measured overlap.
3. **`pushPullFace` with a negative offset on a cylinder's top cap** either
   trips the kernel's own volume gate or silently returns 65+ planar faces
   and no cylinder; the bottom cap is exact in both signs. Blocks retiring
   `tryExactAnalyticCylinderCapOffset`.
4. **`cut` on a thin-walled coaxial bore leaves a T-vertex** on the outer
   seam (wall/r ratio 0.018–0.088): B-rep valid, volume right to 1e-12,
   tessellation not watertight at any deflection — an STL-export defect no
   B-rep check can see. Blocks retiring `tryExactCoaxialCylinderCut`.
5. **Fillet failure modes that don't fail**: returning the input handle as
   if success, and (historically) a volume-doubled solid from the
   partial-revolve blender. The v2 transacted wrappers largely close this;
   finish the migration so *no* public mutating path can return the input
   handle on failure.
6. **Cross-drilled bodies render differently than they measure** — at equal
   radii the viewport shows no hole while volume says there is one; at
   smaller radii the tessellation leaks (1154–1542 boundary edges)
   (`test/cross-drilled-render.test.ts`). Root cause lives with the torus
   tube-band/seam work in P-Class 2.4.

Exit signal: the corpus pin registries stay empty, the four `it.fails` pins
flip to positive, and both `tryExact*` adapter workarounds are deleted with
their tests surviving as kernel regressions.

### S2. Exact measurement — a new kernel ask, not in the P-Class program

`volume()` integrates a tessellation clamped to `diag * 5e-5` of the *whole
solid*, so an identical 2 mm fillet measures 0.2% over on a 20 mm block and
3.5% over on a 2 m beam, silently (`test/filleted-body-volume.test.ts`, both
`it.fails`). `faceArea` on a plane with a curved boundary is a fixed 256-point
inscribed polygon at every deflection. Consequences ripple everywhere: the
`remus-measurement` pin class caps every curved-body volume assertion at
~1e-4, the app carries a `FaceAreaProvenance` field to avoid over-claiming,
and mirror/shell/offset validation gates run against fuzzy numbers.

Ask upstream: **an exact volume/area integrator for analytic and NURBS faces**
(surface integrals per face type; the face integrator already exists for the
torus volume-oracle path), with the tessellation integrator kept as the
fallback for mesh bodies. This single item tightens every oracle in both
repos' test suites and is the cheapest large stability multiplier after S1.

### S3. Cancellation and budgets (P-Class 2.8) — browser-critical

WASM cannot be interrupted: the worker's `cancel` only skips queued jobs, and a
pathological NURBS boolean freezes the geometry worker with no way out
(`geometryWorker.ts:66`, and `guided-reconstruction-plan.md` treats it as a
hard constraint). P-Class 2.8 (OperationContext budgets + cooperative
cancellation, cancel checks at phase boundaries and marcher iterations, a
cancelled op is a typed result) is scheduled inside M2 — **pull it forward**.
It is the single biggest interactivity risk for a web product and it does not
depend on the geometry work around it. App side: thread a cancellation token
through the worker queue and surface a "stop" affordance during long rebuilds.

### S4. Verification infrastructure

- **Wire `approx_census` into CI.** It exists only as
  `crates/operations/examples/approx_census.rs`; the standing rule "census on
  every boolean-adjacent change" is enforced by review, not automation. This
  was already called out in the BrepKit-era audit and never landed.
- **Differential testing harness (P-Class 8.1) — pull early**, as the program
  itself recommends: randomized operation sequences checked against
  invariants (inclusion-exclusion, cut/fuse complementarity, watertightness,
  determinism, journal completeness), failures auto-shrunk to repro bundles,
  nightly.
- **Real-model corpus (P-Class 8.5), shared with the app.** The app's richest
  real-part assertion (160-face hammer holder,
  `test/reconstruction-measurement.test.ts`) is gated on an env var and never
  runs in CI. Collect ≥50 real STEP models with redistribution-safe licenses,
  run import → operate → export nightly in the kernel repo, and promote a
  representative subset into `test/parity/corpus/` here so the app-level gate
  sees them too.
- **Close the fuzzing gaps** the kernel's own testing strategy names: NURBS
  evaluation/intersection, topology mutations, blend and offset inputs
  (today only reachable via `modifier_ops`), plus a persisted minimized
  corpus under version control.
- **Keep the OCCT reference corpus.** It caught what closed forms could not
  (unknown divergences); its cost is one serial CI job. Retiring it stays a
  separate, reversible decision.

### S5. Documentation and pin hygiene (cheap, do immediately)

— done (PR #141)

- `docs/capability-matrix.md` and `TODO.md` still say Remus mirror "refuses
  dense blended/boolean bodies" — measured false on the current pin
  (`test/modeling-operation-preflight.test.ts` now asserts the opposite;
  source and mirror agree to 1.1e-16 relative). Correct both.
- `TODO.md`'s "connect the imported-feature proof query to live kernel face
  adjacency" has landed (`RemusImportedFeatureQuery` reads
  `edgeToFaceMap` on every rebuild); the real remainder is §C5 below.
- `corpus-pins.ts:79`'s note about held-failing corner-chain fillets is
  stale — those flipped to positive pins.
- Upstream: Remus's CHANGELOG stops at 3.0.1 (2026-08-08) while the docs
  record three weeks of landed work; the capability matrix still calls the
  evolution row Beta while README/stability-matrix say Stable.

---

## 3. Track C — Capability (the "most capable" claim)

Ordered by product pull, not kernel-internal convenience.

### C1. The lineage bridge — biggest single capability multiplier

Everything needed to convert the 11 hash-only lineage classes into tracked
lineage. ADR-013 already specifies the contract (five bridge requirements);
the kernel's RFC 0003 stack means most of the machinery exists. Remaining:

- **Kernel:** evolution through the production post-processing path — either
  `unifyFacesWithEvolution` or journaled unify (ADR-013 item 2; for two
  overlapping boxes the kernel history describes a 14-face body while the
  shipped unified union has 6). Real evolution records for offset and direct
  edits (today explicit barriers), and edge/vertex provenance beyond the
  boolean path (both are the kernel's own declared remainder). Pattern
  provenance through instance fusing (depends on S1.2). Fillet provenance
  from construction history rather than normal+centroid matching.
- **Adapter:** adopt `*WithEntityEvolution` / journaled variants under the
  ADR-013 verification gate, class by class, in the order boolean → pattern
  → chamfer → shell/solid-offset → direct edits. Each class that flips makes
  face-attached sketches, direct manipulation, and AI proposals survive
  upstream edits they currently break on.

### C2. Topology query surface — small kernel APIs that retire app heuristics

Each of these replaces a measured workaround:

| Ask | Retires |
| --- | --- |
| Trimmed edge parameter domain (P-Class 2.0 makes this real) | `getEdgeCurveParameters` returning the untrimmed period; the frozen-witness arc displacement pin; curvature-based arc reconstruction |
| Face material-sense query (bore vs. boss) | Multiple `classifyPoint` probes per through-hole classification (`getShapeOrientation` returns `forward` for every face) |
| Ordered wire traversal — **already bound** (`getFaceOuterWire`, `isEdgeForwardInWire`, `isWireClosed`), adopt in the adapter | `chainWireLoop`'s tolerance-matched endpoint walk on a proof path whose contract forbids geometric guessing |
| Per-edge convexity/tangency classification | `adjacencyRelation`'s radial-sense inference with a `'convex'` fallback |
| Distinct identity for sphere patches (and analytic params for sphere/cone/torus in ADR-011 signatures) | The live product limit that a face pick on an imported sphere cannot be stored |
| Seam-edge representation parity (sphere: 32 of 32 edges classified as seams, so no feature edges draw) | The largest surviving corpus divergence class |
| `maxFilletRadius(solid, edges)` | The 3-rung retry ladder that re-runs failed fillets to phrase an error |
| Batched `classifyPoint` + mesh-deviation metric | ~4.5 ms/probe × 40k probes (~3 uninterruptible minutes) in the reconstruction contract |

### C3. General curved booleans (P-Class M2) — the load-bearing wall

Endorse M2 as-planned, with the product-pull ordering made explicit:
2.1 honest-failure hygiene and 2.8 cancellation first (they are stability
items wearing a boolean badge); then 2.2 sphere-sphere and 2.3 Steinmetz
(cheap exact arms); then **2.4 quadric×quadric with NURBS seams** — this is
the item that fixes the census fallback rows, the torus tube-band gap behind
S1.6, and feeds every blend/direct-edit milestone; then 2.5 NURBS×NURBS,
which is the *imported-body ∪ imported-body* case — the workflow a
STEP-centric product lives on; 2.6 scale bands throughout.

### C4. Blend depth (P-Class M5, subset)

The product needs, in order: the v2 walking-engine trim completion and vertex
blends (a revolved wedge currently refuses **all** of its edges at every
radius; corner chains refuse with "unsupported vertex blend"); closed-rim
chamfers; curved-support blends (unblocks the pinned `resize_blend`
cylinder/cone reconstruction refusal and fillets on cylinder-cone shoulders).
Variable radius, setbacks, and face-face blends follow product demand, not
precede it.

### C5. Imported-model editing completion

The proof layer is live; the gaps are precise:

- Publish exact straight-edge polygon loops on planar faces (adapter work,
  via the ordered-wire APIs in C2) and lift the cylinder/cone-only seed gate
  — together these un-isolate the pocket detector.
- Add coordinated edit commands for boss, pocket-depth, and taper-angle
  (schema + guards + preflight, following the `resize-imported-counterbore`
  template).
- Imported-hole depth/angle edits need the plug fuse to stop falling back to
  mesh (an S1/C3 dependency), and chamfered-entry counterbore resizes need
  C4.
- Delete-face-and-heal on curved wounds (P-Class 6.3) retires the
  all-planar `defeature` refusal.
- `importStl` should sew and unify (or a flag should) — today it emits one
  face per triangle with no shared edges and every modeling op refuses the
  result until the adapter repairs it.

### C6. Spend capability that already exists (app work, no kernel changes)

The kernel is ahead of the product in several places; these are comparatively
cheap, high-visibility wins and they broaden what the test corpus exercises:

- **Sketch constraints** on the bound GCS solver (`gcs*` APIs are already
  called for solving; the UI exposes no constraints). This is the largest
  parametric-CAD feature gap versus commercial tools.
- **Section views** (`section` is unused) and **hidden-line drawing export**
  (`projectEdges` is unused) — the seed of a drawings story.
- **Mass properties in the Inspector** (volume/CoM/inertia are computed and
  parsed already; the UI shows volume/bbox/face-count).
- **Assemblies**: kernel hierarchy/transforms/BOM went Stable on 2026-08-21;
  the document model has no assembly concept yet. Start with a design doc —
  this is a schema decision, not a binding call.
- **Interrogation** (P-Class 7.5: clash/clearance, silhouettes, curvature and
  draft-angle maps) as it lands — measurement tools are cheap UI over
  read-only kernel calls.

### C7. Sheet/surface modeling (P-Class M4) — the differentiator, later

Sheet bodies, split-by-sheet, imprint, and multi-region boolean output are
what separate "solid features tool" from "modeling workspace". Sequenced
after M2 by the kernel program for good reasons. The app-side prerequisite to
start now: decide how a non-solid body fits `ProjectDocument` (body types,
selection, rendering) so the kernel work has a consumer the day it lands
("not done until JS can call it" cuts both ways).

---

## 4. Track W — Web platform (the "best web-based" claim)

- **W1. Cancellation** — see S3; listed twice because it is both a stability
  and a platform item, and it is the top of this track.
- **W2. Parallel and streaming tessellation** (P-Class 8.3). Tessellation is
  the interactive-latency bottleneck and is embarrassingly parallel; the
  kernel plan requires bit-identical serial/parallel output. App side,
  decide the threading posture explicitly: single-threaded WASM with
  parallelism across workers, or wasm-threads behind COOP/COEP — a
  deployment decision with product consequences (cross-origin isolation
  breaks third-party embeds) that should be an ADR before code.
- **W3. Load and size budgets.** First-load latency is flagged in the
  capability matrix as unmeasured next to UI startup. Record wasm size per
  kernel bump (the `report-bundle-sizes` gate covers JS; extend it to the
  wasm asset), and measure `loading-remus` cold time on target hardware.
- **W4. Execute the ADR-015 measurement list** (cold rebuild, warm hit,
  eviction, retained heap, large-document cloning, STEP first-load — median
  and p95) and adopt performance budget gates (P-Class 8.2) kernel-side so
  regressions are caught at the PR.
- **W5. Make the checkpoint/restore contract explicit.** The worker's
  history cache depends on an undocumented kernel guarantee — handles
  allocated before a checkpoint stay valid after `restore`; handles after it
  are retired, never reused — currently defended only by a "paranoia probe".
  Ask upstream to document and pin it as a versioned contract. Related:
  arena compaction (`deferred-e6b`) for long sessions, and raising the
  32-checkpoint ceiling (documents beyond it rebuild from scratch every
  sync).
- **W6. API quality**: typed structured returns for the 13
  `JSON.parse(kernel.x())` sites, and structured refusal payloads (the
  `executeBatchV2` failure-category vocabulary exists — expose it on the
  direct API) so the adapter stops regex-matching English.

---

## 5. Track O — Open-source leadership

- **O1. Publish Remus.** "Remus publishes nothing yet" — no crates.io, no
  npm, and the `remus-wasm` name on npm belongs to the no-longer-permissive
  upstream line. For "best open-source web CAD kernel" a released,
  versioned, provenance-signed package is table stakes, and it converts
  OpenZCAD's git-tarball pin into a normal semver dependency. The gate list
  already exists in `fork-maintenance.md`; schedule it rather than letting
  it float.
- **O2. Release discipline**: resume CHANGELOG generation (three weeks of
  landed work is undocumented), and run the `update-remus` dispatch on a
  regular cadence so app-side pins don't drift weeks behind kernel fixes —
  the `AXIS2_PLACEMENT_3D` fix is already sitting unreleased behind a
  `describe.skip` marked UNSKIP-ON-REMUS-PIN-BUMP.
- **O3. Refresh the public benchmarks** (measured 2026-08-06, self-flagged
  as stale, and the excluded `intersect(box, sphere)` defect row should be
  fixed rather than footnoted) — the OCCT-WASM comparison is the project's
  strongest public credibility artifact.
- **O4. Contribution surface**: the qualification-suite pattern
  (`qualify_*.rs`) plus the reproduction-bundle format make narrowly-scoped
  external contributions safe; document a "good first cell" path from the
  capability matrix's Unqualified cells.

---

## 6. Sequencing

Dependency-driven; phases overlap where lanes are disjoint. Kernel items name
their P-Class issue where one exists.

| Order | Item | Track | Where | Effort | Depends on |
| --- | --- | --- | --- | --- | --- |
| 1 | Doc/pin hygiene (S5) | S | both | S | — |
| 2 | Silent-wrongness defects: pattern overlap, pushPull cap, T-vertex cut, operand drop (S1; touches 2.7) | S | kernel | M–L | — |
| 3 | Cancellation + budgets (S3 / 2.8) | S/W | kernel + worker | M | — |
| 4 | `approx_census` in CI; fuzz gaps (S4) | S | kernel | S–M | — |
| 5 | Exact measurement integrator (S2) | S | kernel | M | — |
| 6 | M2 booleans: 2.1 → 2.2 → 2.3 → 2.4 → 2.5 → 2.6 (C3) | C | kernel | L (serial) | 2 |
| 7 | Lineage bridge: unify-evolution + adapter adoption (C1) | C | kernel + adapter | L (parallel lanes) | — (pattern class waits on 2) |
| 8 | Topology query surface (C2) | C | kernel + adapter | M | — |
| 9 | Differential harness + real-model corpus (S4 / 8.1, 8.5) | S | both | M–L | after 2.4 per kernel plan |
| 10 | Sketch constraints, sections, mass properties, HLR export (C6) | C | app | M–L | — |
| 11 | Blend depth subset (C4 / M5) + imported-feature completion (C5) | C | kernel + app | L | 6 |
| 12 | Parallel tessellation + threading ADR (W2) | W | kernel + app | M | 9 guarding |
| 13 | Publish Remus + release cadence (O1–O2) | O | kernel | M | maintainer decision |
| 14 | Direct modeling (M6) and body taxonomy (M4) per product pull (C7) | C | kernel + app | XL | 6, 7 |

The first five rows are the stability program and are deliberately in front of
every capability row: the single-kernel architecture means a silent kernel
wrong answer is a product outage for the affected geometry class, and the
app's distrust harness — clever as it is — is a heuristic standing where a
kernel guarantee should be. The measure of Track S succeeding is that the
harness demotes to a debug assertion because nothing feeds it.

## 7. What not to do

Carried from both repos' standing decisions, so this plan cannot quietly
reopen them: no IGES growth (decided 2026-08-21; STEP is the exchange path);
no mesh bodies as first-class boolean operands; no re-attempting the chases
marked TERMINAL in the kernel roadmap; no feature-count parity with
commercial kernels as a goal — the P-Class D1–D4 properties are the target;
no weakening a test, widening a tolerance, or adding a silent fallback to
turn a red case green; and no nearest-face or traversal-order rebinding as a
substitute for verified lineage, ever.
