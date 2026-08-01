# Kernel execution plan (companion to kernel-roadmap.md)

**Date:** 2026-08-01
**Status:** detailed workstream specs for the roadmap in
`docs/kernel-roadmap.md`. That doc says *what and why*; this one says *how*:
per-workstream current state, design, steps, acceptance gates, and effort.
Verified against BrepKit v2.129.0 sources and the OpenZCAD adapters —
several items turned out cheaper than the roadmap assumed, and are marked.

Effort legend: **S** ≤ 2 days · **M** ≤ 2 weeks · **L** ≤ 6 weeks ·
**XL** > 6 weeks. Estimates are single-agent focus time.

---

## 0. Program structure

```
M0  Safety net + free wins            Z1.1  Z1.2  Z1.3  K0.2→Z2      (all parallel)
M1  Kernel parity                     K0.1  K0.4(=blend 1a/1b/2)  K0.5  Z4  (parallel lanes)
M2  Single kernel                     Z3 → Z5                      (serial, gated on M0+M1)
M3  Workaround retirement + exposure  Z6  Z7                       (parallel)
M4  Competitive kernel                K1.*                          (parallel lanes)
M5  Platform                          K2.*                          (product-sequenced)
```

Hard gates: **Z3 (STEP route flip) must not start until Z1.3's corpus is
recording green baselines through BOTH kernels**, and **Z5 (OCCT deletion)
must not start until Z3 has soaked with the corpus green on BrepKit alone.**

A note on discovered shortcuts (verified in source):

- BrepKit's STEP writer `write_step(topo, &[SolidId])`
  (`crates/io/src/step/writer.rs:30`) already emits **multiple solids** into
  one `ADVANCED_BREP_SHAPE_REPRESENTATION`; only the wasm binding
  (`bindings/io.rs:327`) restricts it to one. K0.2 is a binding change.
- The wasm surface already exposes `defeature`, `removeHolesFromFace`,
  `addHolesToFace`, `makeCylinder` + `copyAndTransformSolid` + `cut` — the
  ingredients of OCCT's `fillThroughHole`/`remove-face-feature`
  compositions. Z4 is adapter-side porting, not kernel work.
- The legacy JS kernel has **no app consumer**: `OpenZCADKernel` is
  referenced only by `exact.ts:53/2301` (mesh reroute), the factory in
  `index.ts:436`, and tests (`test/sample-export.test.ts`,
  `test/kernel-conformance.test.ts`, `test/kernel-seam.test.ts`). Deleting
  it is contained.
- `sweep`, `loft(+Smooth/WithOptions)`, `pipe`, `helicalSweep`,
  `guidedSweep`, `multiSectionSweep`, `draft`, `split`, `section`,
  `thicken`, `massProperties`/`centerOfMass`/`inertiaTensor`,
  `filletVariable`, `chamferDistanceAngle`, `projectEdges`, curvature
  queries, and the full `gcs*` sketch-solver API are **already wasm-bound**.
  Z7 is document-model + UI work, not bindings work.

---

## 1. M0 — Safety net and free wins

### Z1.1 `inspectStep` → BrepKit — **S**

*Current:* `HybridExactKernelAdapter.inspectStep` (`exact.ts:3910-3916`)
unconditionally lazy-loads OCCT; `BrepKitKernelAdapter.inspectStep`
(`exact.ts:3822`) is implemented and unreachable. No production caller
exists (tests + a worker mock only).
*Change:* route to `this.brepkit.inspectStep`. Update the two tests that
assert the OCCT route.
*Acceptance:* existing inspectStep tests pass on the BrepKit
implementation; no `import('./occt-step')` triggered by inspect.

### Z1.2 `imported-mesh` on BrepKit; delete the legacy JS kernel — **M**

*Current:* `containsImportedMesh` reroutes whole documents to
`OpenZCADKernel` (`exact.ts:2293, 3633-3635, 3768-3770`), which silently
loses `mirror`/`shell`/`solid-offset` (no case → generic warning,
`index.ts:347-356`). The OCCT adapter already demonstrates the kernel path:
`occt-step.ts:1425` feeds `kernel.importStl(importedMeshStl(...))`.
*Steps:*
1. Move `importedMeshStl` (triangle arrays → ASCII STL, `occt-step.ts:921`)
   into a shared module.
2. Implement the `imported-mesh` case in the BrepKit `syncDocument` rebuild
   loop using `kernel.importStl`; mesh bodies keep `bodyType:
   'mesh-reference'` semantics and hash-only lineage.
3. Delete the reroute (`exact.ts:3633`, `:3768`) and the `legacy` field.
4. Delete `OpenZCADKernel` (`packages/kernel-adapter/src/index.ts:150-435`),
   the BSP CSG (`packages/geometry/src/csg.ts`), faceted primitives +
   `extrudeProfile`/`revolveProfile`/`booleanSolids`/`healTJunctions` in
   `packages/geometry/src/index.ts` (keep `frameForPlaneRef`, profiles,
   regions — they are document semantics), and the dead JS B-rep STEP
   writer `writeStepFile` (`packages/io-step/src/index.ts:242`; keep
   `parseStepMetadata`).
5. Migrate tests: `sample-export.test.ts` to the exact adapter;
   `kernel-conformance.test.ts` / `kernel-seam.test.ts` become
   BrepKit-behavior pins or are folded into the parity suite.
*Acceptance:* mesh-import documents rebuild with mirror/shell/offset
working (new regression test); STL round-trip volumes match old path within
tessellation tolerance; `packages/geometry` no longer exports CSG.
*Risk:* mesh bodies were never boolean-able with exact bodies on the JS
path either — behavior parity, not regression.

### Z1.3 STEP + geometry parity corpus — **M** (blocks Z3/Z5)

*Purpose:* once OCCT is gone there is no fallback; this corpus **is** the
regression harness. It must exist while both kernels are still present so
baselines can be cross-checked.
*Design:*
- `test/parity/corpus/` — categorized STEP files: (a) all `samples/`
  exports; (b) unit variants (mm / inch `CONVERSION_BASED_UNIT`, degree
  plane angles — the current JS-rewriter case); (c) cavity/void solids
  (`BREP_WITH_VOIDS`); (d) multi-solid files; (e) NURBS-heavy (blend
  results, lofted); (f) known-hostile (the `step-import-compat` cases).
- For each file record through **both** adapters: import warnings, body
  count, volume, face/edge counts, topology witness sets, and a re-export →
  re-import round-trip delta. Baselines in `test/parity/baselines/` with
  the existing `OPENZCAD_WRITE_PARITY_BASELINES=1` recorder convention.
- Extend `test/parity/scenarios.ts` with modeling scenarios that exercise
  every feature kind on top of an imported body (fillet-on-import,
  boolean-with-import, shell-on-import) — these are the cases the mesh
  fallback degrades today and K0.5 must fix.
*Acceptance:* corpus runs in CI (own job, not in the 5s-default vitest
pool); OCCT vs BrepKit deltas are recorded, with per-file expected-failure
pins for known BrepKit gaps (mirroring `EXPECTED_MESH_DEFECTS` style).
The pin list is the working checklist for K0.1/K0.5/K0.6.

### K0.2 → Z2 Multi-solid STEP export — **S kernel + S app**

*Kernel:* add `exportStepMulti(solids: Vec<u32>)` (or widen `exportStep`)
in `crates/wasm/src/bindings/io.rs:327` — `write_step` already accepts the
slice. Conventional-commit PR with a two-solid round-trip test.
*App:* replace the multi-solid branch (`exact.ts:3723-3758`) with the new
binding; delete `getStepCombiner` (`exact.ts:2312`) and
`combineStepSolids` (`occt-step.ts:2119`).
*Acceptance:* `sample-export` multi-body STEP reimports as N solids in both
OCCT (while it lasts) and BrepKit; no `import('./occt-step')` fires for
documents without `imported-step`.

---

## 2. M1 — Kernel parity (BrepKit work, parallel lanes)

### K0.1 STEP import/export fidelity — **L** (lane A)

All in `esaueng/brepkit`, `crates/io/src/step/`.

1. **Units (the OpenZCAD-blocking bug).** Parse
   `GLOBAL_UNIT_ASSIGNED_CONTEXT` → resolve `LENGTH_UNIT` (SI prefix +
   `CONVERSION_BASED_UNIT`, e.g. inch) and `PLANE_ANGLE_UNIT` (degree).
   Apply one uniform scale to all `CARTESIAN_POINT`s and radii at parse
   time; convert angle-typed parameters (conical half-angle) to radians.
   Kills OpenZCAD's `normalizeStepPlaneAnglesForKernel` STEP-text rewriter
   (`step-import.ts:222`) and the inch-file wrongness.
   *Tests:* inch cube (25.4 mm), degree-cone from the OpenZCAD workaround's
   fixture, mixed-unit corpus files.
2. **Voids.** Reader: accept `BREP_WITH_VOIDS` / `ORIENTED_CLOSED_SHELL`,
   build `Solid::new(outer, inner_shells)` (topology already models inner
   shells — `reader.rs:249` just passes `Vec::new()`). Writer: emit
   `BREP_WITH_VOIDS` when `solid.inner_shells()` is non-empty —
   `write_solid` (`writer.rs:545`) currently silently drops cavities.
   *Tests:* hollow cube round-trip preserving volume (outer−inner).
3. **Entity widening (import-side conversion, no new topology types yet).**
   `SURFACE_OF_REVOLUTION` / `SURFACE_OF_LINEAR_EXTRUSION`: detect
   analytic collapse (cylinder/cone/sphere/torus) else convert to NURBS on
   import. `TRIMMED_CURVE` / `POLYLINE` → underlying curve + trim / line
   chain. Unknown entities keep failing typed (`UnsupportedEntity`) — no
   silent skips.
4. **AP214/AP242 header acceptance** on read (schema string tolerance);
   keep AP203 write for now, AP214 write as a follow-up flag.
5. **Multi-solid + assembly flattening**: reader already collects every
   `MANIFOLD_SOLID_BREP`; add `NEXT_ASSEMBLY_USAGE_OCCURRENCE` +
   `ITEM_DEFINED_TRANSFORMATION` traversal so instanced parts import at
   their placed transforms (flattened is acceptable for parity; true
   assembly structure is K2).
*Acceptance:* Z1.3 corpus categories (b), (c), (d) go green on BrepKit;
OpenZCAD deletes `step-import.ts`'s rewriter in Z3.

### K0.4 Blend phases — **L** (lane B; already specced)

Execute `docs/qa/2026-08-01/kernel-fillet-plan.md` phases 1a → 1b → 2 with
the handoff/orchestration doc (`agent-handoff-fillet-phases.md`). Phase 0
(typed errors) is merged (esaueng/brepkit#35). Adds, beyond the plate cases:
retire the adapter's `tryExactAnalyticCylinderRimFillet` once phase 2
lands (Z6.1).

### K0.5 Boolean: analytic×NURBS SSI + torus pairs — **XL** (lane C, hardest)

*Current:* `phase_ff.rs:3024-3032` returns `Ok(vec![])` for any
analytic×NURBS pair → no intersection curves → GFA fails → mesh fallback →
analytic faces destroyed. Torus×(anything but plane) likewise unwired
(`classifier/analytic.rs:483`).
*Approach (staged):*
1. **Analytic×NURBS curve tracing.** The analytic side has an implicit
   form f(p)=0; substitute the NURBS surface S(u,v) and trace f(S(u,v))=0
   in the (u,v) domain: seed points via the existing Bézier-clipping
   machinery (`math/nurbs/bezier_clip.rs`) against the implicit surface,
   then predictor-corrector marching with step control from curvature;
   fit result to `NurbsCurve` (LSPIA fitting already in `math`). Emit
   pcurves on both faces (reuse `compute_pcurve_on_surface`).
2. **Torus×quadric**: same implicit-implicit tracing (torus has degree-4
   implicit); reuse the marching core.
3. Wire both into the pave filler; extend the analytic classifier's bail
   list accordingly.
4. Re-tighten the loosened volume tolerances
   (`boolean/tests.rs:2631,2718`) as part of acceptance.
*Acceptance:* Z1.3 scenario pins "fillet-on-import", "boolean-with-import"
flip from mesh-fallback to exact; `brepkit_approx` census shows zero
mesh-fallback events on the corpus; volume assertions at 0.05.
*Risk:* genuinely hard numerics. Mitigate by keeping the bounded mesh
fallback as the safety valve (it stays; it just stops being *reached* for
these classes).

### K0.6 Import validation + lineage parity — **M** (lane A tail)

*Current:* `occt-step.ts` provides `importedStepValidationWarning` and
imported-body topology witnesses; BrepKit path must match before Z3.
*Steps:* map `kernel.validateSolid` + `meshQuality` to the same warning
taxonomy; ensure imported bodies publish witness sets (fingerprint parity
already exists per ADR-011 for analytic faces; closed-B-spline faces stay
fail-closed as today); port the unit-rescale (`uniformScaleTransform`)
behavior if K0.1 lands unit handling kernel-side (then it's free).
*Acceptance:* corpus warning sets match OCCT baselines or are strictly
better (fewer false warnings, never fewer true ones).

### Z4 Port the two OCCT-only direct edits — **M** (lane D, app-side)

*Done.* Both kinds run on the BrepKit path and agree with OCCT
volume-for-volume; the cross-kernel agreement test drives the same edit
sequence on each kernel through that kernel's own fingerprints.
*How:* `classifyThroughHoleFace` replaces OCCT's face-orientation test with
point-in-solid probes (BrepKit reports every face as `forward`);
`requireThroughHole` ports the fail-closed source re-validation and its
tolerances unchanged; `fillThroughHole` is the plug fuse plus `unifyFaces`;
`resizeThroughHole` reaches OCCT's `(body ∪ bore) \ newBore` with one
boolean instead of two, which is the same set and avoids the plug fuse
BrepKit often declines.
*Residual, both K0.3:* closing a hole falls back to a co-refined mesh on
many plate bodies (detected by face count, refused), and `defeature` only
accepts all-planar bodies and returns a wrong solid on every non-trivial
one tried (refused by strict `validateSolid`).

---

## 3. M2 — Single kernel

### Z3 STEP route flip — **M**, gated on K0.1 + K0.6 + Z1.3 green

*Steps:* delete `containsImportedStep` routing (`exact.ts:3862-3908`) so
`imported-step` documents rebuild on the BrepKit adapter (its
`imported-step` case at `exact.ts:2800` becomes production); delete
`normalizeStepPlaneAnglesForKernel` + its tests; keep the corpus running
both kernels until Z5.
*Soak:* at least one release with corpus + real-project imports green on
BrepKit while OCCT still exists behind a dev flag (vitest alias mechanism,
`vitest.config.ts:29-32`, already supports kernel swapping).

### Z5 Delete OCCT — **M**

Deletion inventory (from the usage map):
`packages/kernel-adapter/src/occt-step.ts` (~2,150 lines),
`occt-modeling-operations.ts`, `occt-lineage.ts` (27 KB) + their tests,
`test/step-import-compat.test.ts` and `test/topology-lineage-spike.test.ts`
(rewrite as BrepKit-only), `occt-wasm` from
`packages/kernel-adapter/package.json:19`, the vite manual chunk
(`apps/web/vite.config.ts:196`), `ExactKernelKind = 'brepkit' | 'occt'` +
`OCCT_SHARP_OFFSET_LIMITATION` (`apps/web/src/lib/modelingOperations.ts:63-138`)
and the `App.tsx:5527` branch, the `loading-occt` worker phase
(`geometryWorker.ts:20-26,134-137`), cross-kernel assertions in
`exact-kernel-adapter.test.ts`.
Docs: amend ADR-009/ADR-010, README "Two kernels" section,
`capability-matrix.md`, `performance-baseline.md`.
*Payoff:* −22,088 kB wasm (−7,100 kB brotli), one code path.
*Rule:* this lands only after Z3's soak; revert path is `git revert` of one
PR (keep the deletion atomic).

---

## 4. M3 — Workaround retirement (Z6) and capability exposure (Z7)

### Z6 itemized

| Item | Retire when | Work |
| --- | --- | --- |
| `tryExactAnalyticCylinderRimFillet` (`exact.ts:385`) | K0.4 phase 2 | delete + keep its tests as kernel regressions — **S** |
| `tryExactAnalyticCylinderCapOffset` / `tryExactCoaxialCylinderCut` | K0.5 + a kernel coaxial-cut fast path | delete — **S** each |
| Boolean distrust harness (`boolean-result-validation.ts`) | after N releases with zero census failures on the corpus post-K0.5 | demote to debug assertion behind a flag — **S** |
| STEP text rewriter (`step-import.ts`) | K0.1 | delete in Z3 — **S** |
| Viewport geometric edge-walk (`edgeChain.ts`) + chord-midpoint snaps (`topologySnaps.ts`) | adjacency/exact-curve publishing (below) | rewrite walk topologically — **M** |

**Adjacency + exact-curve publishing (the one new protocol):** extend the
worker topology payload so each edge carries `adjacentFaceHashes:
[number, number]` and `curve: { type, params }` (line/circle/ellipse/nurbs,
from `getEdgeCurveType` + `getEdgeCurveParameters` — both adapters already
compute adjacency internally: `exact.ts:252`, `occt-step.ts:115`). Bump the
worker protocol version; viewport consumes it for edge-run walking, arc
midpoints, and future measure tools. **M**, kernel-independent, can start
any time.

### Z7 Feature exposure (each: document-core feature/params + command +
worker case + UI form + AI-contract op + tests)

| Feature | Kernel binding | Extra notes | Est |
| --- | --- | --- | --- |
| Partial revolve + axis-by-selection | `revolve(..., angleDeg)` exists; app hard-codes 360 (`exact.ts:2722`) | TODO.md already lists it | **S–M** |
| Symmetric / two-sided extrude | compose two `extrude` + `fuse`, or start-offset the profile | document-model change (`distanceBack`) | **M** |
| Sweep / loft / helix features | `sweep*`, `loft*`, `helicalSweep` bound | needs path/profile selection UX — the real cost | **L** (mostly UI) |
| Split body | `split` bound | plane from face/datum selection | **M** |
| Section view | `section` bound + viewport clip plane | display-only first (clip), analytic section second | **M** |
| Mass properties in Inspector | `massProperties`, `centerOfMass`, `inertiaTensor` bound | needs a density/material field on bodies | **S–M** |
| Variable-radius fillet, distance-angle chamfer | `filletVariable`, `chamferDistanceAngle` bound | UI: per-vertex radius entry | **M** |
| Hole feature (drill/cbore/csink) | compose cylinders/cones + cut; `recognizeFeatures` for edit-on-import later | standards table is app data | **M** |
| Sketch constraints | full `gcs*` API bound (19 of 24 constraints) | the largest app lift: sketch data model + solver loop + UI; stage after M2 | **XL** |

AI contracts: every new feature kind needs a schema op + capability flag
(pattern exists: `AI_PATCH_*_ENABLED` in `cloudflare-adapters`).

---

## 5. M4 — Competitive kernel (K1, parallel lanes after M1)

| Lane | Work | Key sites | Est |
| --- | --- | --- | --- |
| Blend | chamfer walker (`chamfer_builder.rs:377` "walker not yet integrated"); torus/NURBS blend pairs (`analytic.rs:31-36,192-343`); trimming beyond planes (`builder_utils.rs:203`); setbacks, face-face, full-round; promote variable radius off deprecated v1 sampling | `crates/blend` | **XL** |
| Offset | cavity shells (`offset/lib.rs:90`), arc joints (`arc_joint.rs:16`), self-intersection removal (`self_int.rs:20`), NURBS intersection (`inter3d.rs:156`) — this also lifts shell/thicken quality | `crates/offset` | **L–XL** |
| Boolean | same-domain full merge (`same_domain.rs:14`), off-axis cones (`boolean/mod.rs:1413`), non-planar coincident contact (`:914`), volume-accuracy fix | `crates/algo`, `operations/boolean` | **L** |
| Types | add `EdgeCurve::{Hyperbola, Parabola}` (unblocks `convert_to_elementary`), `FaceSurface::{OffsetSurface, SurfaceOfRevolution, SurfaceOfExtrusion}`; give `Plane` a UV parameterization to kill plane special-casing | `crates/topology`, ripple across algo/blend/io | **XL**, stage by variant |
| Sweep/loft | implement `SweepCornerMode::Round` (today silently degrades, `sweep.rs:1185`); non-planar caps with holes / >4 edges (`cap.rs:141-146`); draft on non-planar faces | `crates/operations` | **L** |
| Tessellation | close the planar inner-wire TODO (`tessellate/planar.rs:18` — verify against `tessellate_watertight.rs` first; may be stale) | | **S** |
| Hardening | fuzz booleans/blends with **structured generators** (random primitive trees + transforms; invariants: closed shell, volume ⊆ operand bounds, determinism, fuse/cut idempotence) — I/O readers are fuzzed, engines are not; extend `mutants.toml` to `blend`/`offset`/`operations`; keep the `brepkit_approx` census as a CI metric | `fuzz/`, `mutants.toml` | **M–L** |

## 6. M5 — Platform (K2, product-sequenced)

- **Assemblies:** mates/joints over the existing transform-tree + BOM;
  assembly interference (pairwise `solidToSolidDistance` + intersect
  volume, both bound); STEP assembly round-trip (K0.1 step 5 grows into
  real structure). OpenZCAD side: multi-part documents (the
  `AssemblyNode`/`PartNode` schema already exists but is fixed at 1×1).
- **Evolution/persistent naming:** promote `evolution.rs` from Beta,
  extend to blends/patterns/direct edits so the adapter's hash-only
  lineage classes (boolean, fillet, chamfer, pattern, offset) become
  tracked; this directly upgrades OpenZCAD's fail-closed reference UX.
- **Drawings/PMI:** dimensions over `projectEdges` HLR; STEP colors/PMI
  (reader/writer entities are greenfield).
- **Sheet metal:** greenfield; only on product demand.

---

## 7. Ownership and cadence

- Kernel lanes (K0.1/K0.4/K0.5, later K1) are independent brepkit PR
  streams — same worker pattern as the fillet handoff
  (`docs/qa/2026-08-01/agent-handoff-fillet-phases.md`), one phase per PR,
  conventional commits, fmt/clippy/boundaries green.
- App lanes (Z1, Z2, Z4, Z6, Z7) are OpenZCAD PR streams; each Z-flip PR
  carries its corpus evidence in the description.
- Every routing flip (Z2/Z3/Z5) is its own atomic PR with a one-PR revert
  path.
- Pin-bump discipline: kernel changes reach the app only via
  `chore(wasm): refresh committed package` + lockfile pin bump, with the
  corpus re-run in the bump PR.
