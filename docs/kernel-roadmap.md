# Kernel roadmap: BrepKit as the sole, professional-grade kernel

**Date:** 2026-08-01
**Scope:** Findings from a full review of BrepKit (v2.129.0, 257k LOC Rust)
and its use in OpenZCAD, and the plan that follows from them. Two goals, per
the product direction:

1. **Make BrepKit a fully featured, professional CAD kernel.**
2. **Make OpenZCAD use BrepKit for everything** — remove the OCCT fallback
   and the legacy JS kernel entirely; no backup kernel.

Related: `docs/adrs/ADR-009-brepkit-browser-kernel.md` (BrepKit primary),
`docs/qa/2026-08-01/` (fillet investigation + phased blend plan, Phase 0
merged as esaueng/brepkit#35), `docs/capability-matrix.md`.

---

## 1. Where things actually stand

### 1.1 The "Exact B-rep" label hides three engines

The status bar says one kernel; routing in
`packages/kernel-adapter/src/exact.ts` says three:

| Engine | When it runs | Size |
| --- | --- | --- |
| **BrepKit** (`brepkit-wasm`) | Every document without imports — the primary path (`exact.ts` ≈ 3886) | 5.2 MB wasm |
| **OCCT** (`occt-wasm@3.8.0`) | The **whole document** reroutes to `OcctStepKernelAdapter` if it contains one `imported-step` feature; also pulled into pure-BrepKit docs for multi-body STEP export (`combineStepSolids`), and `inspectStep` is unconditionally OCCT | 22 MB wasm |
| **Legacy JS polyhedral kernel** (`OpenZCADKernel` + `packages/geometry` BSP CSG) | The whole document reroutes here if it contains an `imported-mesh` feature (and no STEP) | — |

> **Superseded by Track Z.** All three routes are gone. Z1.1 moved
> `inspectStep`, Z1.2 deleted the legacy JS kernel, Z2 moved multi-solid
> export, and Z3 removed the `imported-step` reroute — so `createExactKernelAdapter`
> returns `BrepKitKernelAdapter` and nothing in `apps/` or the production
> adapter path imports `occt-step` at all. Z5 then removed OCCT from the
> package entirely; it survives only as the parity corpus's reference kernel
> in `test/parity/occt-reference/`. The table is kept because it is the
> diagnosis the rest of this document argues from.

Every document feature now has a BrepKit implementation. The two that were
OCCT-only — `resize-through-hole` and `remove-face-feature` — were ported in
Z4; what remains is not a missing implementation but two BrepKit boolean and
defeature limitations those edits fail closed on (see Z4 below).

Around the kernels sits a ring of JS that either works around BrepKit
defects or substitutes for data BrepKit doesn't publish:

- `step-import.ts` `normalizeStepPlaneAnglesForKernel` — a STEP **text
  rewriter** compensating for BrepKit ignoring `PLANE_ANGLE_UNIT` (degrees
  → radians for conical half-angles).
- Three analytic-cylinder shortcuts inside `exact.ts`
  (`tryExactAnalyticCylinderRimFillet`, `…CapOffset`, `…CoaxialCylinderCut`)
  — JS re-implementations of operations the kernel should own.
- `boolean-result-validation.ts` + `union-connectivity.ts` — a JS distrust
  harness re-judging every kernel union at the mesh level.
- Viewport `edgeChain.ts` walks edge runs **geometrically** because the
  adapters compute edge↔face adjacency internally but never publish it;
  `topologySnaps.ts` snaps to chord midpoints because edges arrive as
  polylines without exact curve parameters.

### 1.2 BrepKit is stronger than OpenZCAD's use of it

OpenZCAD's document model has 15 feature kinds; extrude is
distance-only, revolve is hard-coded 360°, sketches have five object types
and **zero constraints**. Meanwhile BrepKit already ships, unused by
OpenZCAD:

- **Sweep** (5 variants incl. guided + multi-section), **loft**, **pipe**,
  **helix**, **fill-face** (Coons).
- **Partial revolve** (planar profiles), **draft** (planar), **split by
  plane**, **section faces**, **thicken**, **convex hull**, **Minkowski**.
- **Variable-radius fillet**, chamfer distance-angle and asymmetric.
- **Mass properties**: volume, CoM, inertia tensor + principal axes —
  OpenZCAD's Inspector shows only volume/bbox/face-count.
- **A 24-constraint 2D GCS sketch solver** (DogLeg trust region, DOF/rank
  analysis) — OpenZCAD has no constraint solving at all.
- **Feature recognition** (holes, chamfers, pockets, patterns), healing
  pipeline (26 configurable fixes), STL/3MF/OBJ/PLY/glTF I/O.

A large fraction of "make OpenZCAD professional" is therefore **exposing
kernel capability that already exists**, not writing kernel code.

### 1.3 BrepKit's real weaknesses (the honest list)

From the maturity review (stability matrix, explicit `unsupported` sites,
changelog shape):

1. **Blend engine** — the weakest subsystem. v2 walking engine fails fast
   on any vertex where ≥2 stripes meet (`fillet_builder.rs` ≈ 141); the v1
   rolling-ball engine that covers corners is `#[deprecated]` and can't do
   closed circular edges; **chamfer has no walker fallback at all**
   (`chamfer_builder.rs` ≈ 377: "walker not yet integrated"); torus and
   NURBS blend pairs are entirely unwired; blend trimming supports planes
   only. (This is exactly what the plate investigation hit; phases 1–2 in
   `docs/qa/2026-08-01/kernel-fillet-plan.md` are the start.)
2. **Boolean engine: analytic×NURBS surface-surface intersection returns
   empty** (`phase_ff.rs` ≈ 3024 — "Deferred… analytic-NURBS is complex"),
   so any cylinder/cone/sphere against a NURBS face forces the mesh
   fallback, which destroys analytic surfaces. Torus×torus and
   torus×other have known gaps. Volume-accuracy assertions are loosened
   pending a fix. Robustness is regression-driven (~150 case-by-case
   `fix(algo)` entries in one release) rather than argued generally.
3. **Offset engine** — cavity shells rejected, arc joints unimplemented,
   self-intersection removal unimplemented, NURBS intersection
   unimplemented.
4. **Surface/curve type set is small**: 6 face surfaces (plane, cylinder,
   cone, sphere, torus, NURBS) and 4 edge curves (line, NURBS, circle,
   ellipse). No offset surface, no surface of revolution/extrusion, no
   hyperbola/parabola — forcing NURBS approximation at many steps and
   limiting STEP fidelity.
5. **STEP I/O fidelity**: AP203 only; **no unit conversion**
   (inch files import wrong; the plane-angle bug is worked around in
   OpenZCAD JS); **inner/void shells neither read nor written**; assembly
   structure flattened; no colors/PMI; `SURFACE_OF_REVOLUTION`,
   `TRIMMED_CURVE`, etc. unsupported. IGES is experimental (analytic
   surfaces export nothing).
6. **No parametric history / persistent naming** in the kernel — OpenZCAD
   supplies this host-side (ADR-011/013 witnesses), which is a defensible
   architecture, but face-evolution output from the kernel is Beta and
   most operations remain "hash-only" lineage in the adapter.
7. **Test infrastructure gaps**: fuzzing covers I/O readers only — the
   boolean, blend and NURBS engines are unfuzzed; mutation testing skips
   `blend`, `offset`, `heal`, `operations`.

Credit where due: fail-closed contracts everywhere, `unsafe` denied,
deterministic hashing, bounded fallback budgets, the `brepkit_approx`
degradation probes, and a self-honest stability matrix. The foundation is
right; the gaps above are what stands between it and a professional kernel.

---

## 2. Track K — BrepKit to a professional kernel

Ordered by leverage. K0 is also the dependency for Track Z (OCCT removal).

### K0 — Parity blockers (what OpenZCAD needs to drop OCCT)

| # | Work | Kills |
| --- | --- | --- |
| K0.1 | **STEP import fidelity**: honor `GLOBAL_UNIT_ASSIGNED_CONTEXT` + `CONVERSION_BASED_UNIT` (length AND plane angle); read `BREP_WITH_VOIDS`/inner shells; write inner shells (today `write_solid` silently drops cavities); convert `SURFACE_OF_REVOLUTION`/`_LINEAR_EXTRUSION`/`TRIMMED_CURVE` to supported types on import instead of `UnsupportedEntity`; accept AP214 headers | The `normalizeStepPlaneAnglesForKernel` text rewriter; the OCCT import route |
| K0.2 | **Multi-solid STEP export** (compound / multiple `MANIFOLD_SOLID_BREP` in one file) | `combineStepSolids` — the only OCCT intrusion into pure-BrepKit documents |
| K0.3 | **Through-hole close + general defeature**: a `fill_through_hole` op and defeature beyond planar faces | The two OCCT-only direct edits (`resize-through-hole`, `remove-face-feature`) |
| K0.4 | **Blend phases 1–2** (already planned in `docs/qa/2026-08-01/kernel-fillet-plan.md`): holed-cap corner fillets, walking-builder vertex blends, concave hole-rim fillets/chamfers | The plate-class failures; the adapter's analytic rim-fillet shortcut |
| K0.5 | **Analytic×NURBS SSI** in the boolean engine, + torus pairs | Mesh-fallback degradation on any boolean touching an imported/blended face — the main source of the JS boolean distrust harness |
| K0.6 | **STEP-import validation + lineage story** equal to what `occt-step.ts` provides (import warnings, topology witnesses on imported bodies) | The last reason the OCCT adapter exists |

### K1 — Professional-competitive modeling

- **Blend completion**: chamfer walker; torus/NURBS blend pairs; blend
  trimming beyond planes; setback corners; face-face blends; full-round;
  promote variable-radius off the deprecated v1 sampling path.
- **Offset engine**: cavity shells, arc joints, self-intersection removal,
  NURBS-NURBS intersection. (Shell/thicken quality follows this.)
- **Boolean generalization**: same-domain merge beyond pairwise records,
  off-axis cone coaxial handling, volume-accuracy fix (re-tighten the
  loosened test tolerances), non-planar coincident contact.
- **Surface/curve types**: add offset surface, surface of revolution /
  extrusion, hyperbola/parabola edges; give planes a UV parameterization to
  kill the plane special-casing.
- **Sweep/loft polish**: implement `SweepCornerMode::Round` (today it
  silently degrades to smooth); non-planar caps with holes / >4 edges;
  draft on non-planar faces.
- **Tessellation**: close the "inner wires on planar faces" TODO; publish
  exact curve parameters alongside display polylines (see Z6).
- **Direct modeling**: move-face-set with adjacent-face re-solve;
  delete-face-and-heal beyond planar defeaturing.
- **Hardening**: fuzz the boolean/blend/NURBS engines (structured solid
  generators, not just byte fuzzing); extend mutation testing to `blend`,
  `offset`, `operations`; keep the approx-census in CI.

### K2 — Platform features (sequence by product need)

- **Assemblies**: mates/joints on top of the existing transform-tree +
  BOM; assembly-level interference; STEP assembly round-trip (needs K0.1).
- **Persistent naming/evolution**: promote face evolution from Beta,
  extend to blends/patterns/direct edits, so OpenZCAD's hash-only lineage
  classes can become tracked lineage.
- **Drawings/PMI**: dimensions + annotations over the existing HLR
  projection; STEP colors/PMI.
- **Sheet metal** (unfold/bend) — greenfield; only if the product wants it.

---

## 3. Track Z — OpenZCAD 100% on BrepKit

Ordered so each step ships independently and the OCCT deletion lands as a
single final cut with evidence behind it.

### Z1 — Immediate (no kernel work required)

1. **`inspectStep` → BrepKit.** `BrepKitKernelAdapter.inspectStep` exists
   and works; the hybrid unconditionally routes to OCCT and has **no
   production caller**. One-line change plus test updates.
2. **Route `imported-mesh` documents to BrepKit.** BrepKit imports STL
   (`importStl`) exactly as OCCT does today (`occt-step.ts` ≈ 1425 feeds it
   an ASCII STL string). Add the `imported-mesh` case to the BrepKit
   adapter, then **delete the legacy JS kernel**: `OpenZCADKernel`, the BSP
   CSG (`packages/geometry/src/csg.ts`), the faceted primitives, and the
   dead hand-written JS STEP writer (`io-step` `writeStepFile` — currently
   unreachable and emits faceted geometry labeled as B-rep). Note the JS
   compat kernel silently drops mirror/shell/solid-offset on mesh docs
   today, so this is a correctness fix, not just cleanup.
3. **Build the migration safety net**: extend `test/parity/` with a STEP
   corpus (every sample + representative real files incl. inch-unit and
   cavity parts) replayed through both adapters, pinning volumes, face
   counts, topology witnesses, and import warnings. This corpus is the
   acceptance gate for Z3–Z5 and the permanent regression harness once
   OCCT is gone — with no backup kernel, this replaces it as the check.

### Z2 — Multi-body STEP export (needs K0.2)

Switch `exportStep` multi-solid to BrepKit's compound writer; delete
`getStepCombiner`/`combineStepSolids`. After this, no pure-BrepKit document
ever loads OCCT.

### Z3 — STEP import on BrepKit — **done**

`containsImportedStep` routing is deleted: `imported-step` documents rebuild
on BrepKit, and `step-import.ts`'s angle rewriter is gone (superseded by
kernel unit handling — removing it changed no corpus baseline, which is the
evidence it was already inert). The Z1.3 corpus stayed green through the
flip, and the app-side mirrors went with it: the worker no longer posts a
`loading-occt` phase and the UI no longer gates solid offset on imported
bodies behind OpenCascade's convex-planar limit.

The known cost, recorded rather than smoothed over: BrepKit blends fit
B-spline bands where the exact answer is a quarter cylinder (K0.4, 4.63e-4
on `fillet-on-import`), so users blending imported bodies get a NURBS
approximation where OCCT gave an exact cylinder. BrepKit does this on
natively modelled bodies too, so the flip extends an existing gap rather
than creating one.

### Z4 — Port the OCCT-only direct edits — **done, with two K0.3 gaps**

`resize-through-hole` and `remove-face-feature` run on the BrepKit path and
agree with OCCT volume-for-volume (`test/exact-kernel-adapter.test.ts`,
"resizes and removes a through hole identically on BrepKit and
OpenCascade"). Through-hole classification is derived from point-in-solid
probes because BrepKit faces carry no orientation flag.

Two cases still refuse, both waiting on K0.3 rather than on adapter work:

- **Closing a hole** (`remove-face-feature` on a through-hole) is a plug
  fuse, and BrepKit's GFA boolean often declines the handle-collapsing
  configuration and falls back to a co-refined mesh. It succeeds on a
  cylindrical body and frequently fails on a plate. The adapter detects the
  fallback by face count and refuses rather than shipping a faceted body.
  `resize-through-hole` is unaffected: it reaches the same set with one
  boolean instead of two and never needs the plug.
- **`defeature`** rebuilds a body from the planes of the faces it keeps, so
  it accepts only all-planar bodies and returns a wrong solid on every
  non-trivial one tried (chamfer, pocket, boss, notch — each fails
  `validateSolid`). The adapter refuses both the unsupported-body case up
  front and the wrong-solid case after the call.

### Z5 — Delete OCCT — **done (2026-08-01)**

`occt-step.ts` (2,130 lines), `occt-modeling-operations.ts`, `occt-lineage.ts`
and their tests are gone from `packages/kernel-adapter`; `occt-wasm` is a root
**devDependency** rather than an adapter dependency; the
`ExactKernelKind = 'brepkit' | 'occt'` union, `OCCT_SHARP_OFFSET_LIMITATION`,
the `offsetTopology` capability field, and the constant `kernel: 'brepkit'`
argument in `App.tsx` are deleted. `ExactKernelAdapter.kind` is now the literal
`'brepkit'` with one implementation.

Two inventory items above were already absent and needed no work: the
`loading-occt` worker phase (Z3) and the vite manual chunk. `step-import-compat`
was already BrepKit-only.

The cluster was **relocated, not destroyed** — `test/parity/occt-reference/`,
where the parity corpus still runs it against BrepKit file by file, and where
`generate.spec.ts` still needs it to author the two OCCT-written fixtures. It
no longer implements `ExactKernelAdapter`, so it is not a kernel the app can be
pointed at. Retiring the comparison is now its own reversible decision.

Cross-kernel assertions in `exact-kernel-adapter.test.ts`, `kernel-seam.test.ts`
and `topology-lineage-spike.test.ts` were replaced by the absolute claims they
stood in for — closed-form volumes, pinned counts, named refusals — not deleted.

**Payoff: one code path, one behavior.** The −22 MB wasm (−7.1 MB brotli)
landed at Z3, because the OCCT import was dynamic. Z5's own bundle delta is
321 bytes: the dead `OCCT_SHARP_OFFSET_LIMITATION` string and its unreachable
branch were still being emitted into `assets/index-*.js`. What Z5 recovers is
~4,460 lines of source moved out of the shipped package.

### Z6 — Retire the JS workaround ring (paced by Track K)

- Analytic shortcut trio in `exact.ts` → delete as K0.4/K1 land (each is a
  kernel defect worked around in the adapter).
- JS boolean distrust harness → keep until K0.5 + boolean volume-accuracy
  fix, then demote to a debug assertion.
- **Publish edge↔face adjacency and exact curve parameters** from the
  adapter to the viewport (both adapters already compute adjacency
  internally) → kills the geometric edge-run walker and fixes
  chord-midpoint snapping on arcs.
- Adopt the kernel GCS solver for sketch constraints when the sketch UI
  grows constraints (the app currently has none — this is an app feature
  gap, not a kernel gap).
- `regions.ts` (the 1,700-line JS sketch-region solver) **stays JS for
  now**: its region fingerprints are persisted document identity, so a
  kernel-side replacement is a schema migration, not a swap. Revisit only
  with a migration plan.

### Z7 — Spend the freed capability (app features on existing kernel ops)

Cheap wins once the single-kernel base is stable, all backed by ops BrepKit
already has: partial revolve + revolve-about-selected-axis; symmetric /
two-sided / drafted extrude; sweep, loft, helix features; split body;
section view (kernel `section` + viewport clipping); mass properties in the
Inspector; variable-radius fillet + distance-angle chamfer forms; hole
feature built on feature recognition + through-hole ops.

---

## 4. Suggested sequencing

| Order | Item | Track | Depends on |
| --- | --- | --- | --- |
| 1 | Z1.1 inspectStep flip, Z1.2 mesh docs → BrepKit + JS-kernel deletion, Z1.3 parity corpus | Z | — |
| 2 | K0.4 blend phases 1–2 (already planned/handed off) | K | — |
| 3 | K0.1 STEP fidelity + K0.2 compound export | K | — |
| 4 | Z2 compound export flip | Z | K0.2 |
| 5 | K0.5 analytic×NURBS SSI; K0.3 defeature/through-hole; K0.6 import validation | K | — |
| 6 | Z3 STEP route flip → Z4 direct-edit port → Z5 OCCT deletion | Z | K0.* |
| 7 | Z6 workaround-ring retirement; Z7 feature exposure | Z | paced by K |
| 8 | K1 competitive modeling; K2 platform | K | product priority |

**Risk to hold in view:** with OCCT gone there is no fallback — a BrepKit
regression is a product outage for the affected geometry class. The Z1.3
corpus (plus BrepKit's own regression discipline, which is genuinely good)
is the mitigation, and it must land **before** any routing flip, not after.
