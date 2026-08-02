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

### Z1.1 `inspectStep` → BrepKit — **S code, gated on K0.1** ✅ done

*Current:* `HybridExactKernelAdapter.inspectStep` (`exact.ts:3910-3916`)
unconditionally lazy-loads OCCT; `BrepKitKernelAdapter.inspectStep`
(`exact.ts:3822`) is implemented and unreachable. No production caller
exists (tests + a worker mock only).
*Change:* route to `this.brepkit.inspectStep`. Update the two tests that
assert the OCCT route.
*Acceptance:* existing inspectStep tests pass on the BrepKit
implementation; no `import('./occt-step')` triggered by inspect.

> **This was not a free win.** The one-line flip failed 4 tests with
> `unsupported STEP entity: SURFACE_CURVE`. OCCT wraps the 3-D geometry of
> essentially every edge on a curved face in `SURFACE_CURVE`, and BrepKit's
> reader had no arm for it — so BrepKit could not read STEP written by any
> real CAD system, including our own OCCT-produced exports. The flip is
> therefore gated on K0.1 item 3, which is promoted to the critical path.
> Landed together with Z2 once the pin carried the fix.

### Z1.2 `imported-mesh` on BrepKit; delete the legacy JS kernel — **M** ✅ done

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

### Z1.3 STEP + geometry parity corpus — **M** (blocks Z3/Z5) ✅ done

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

### K0.2 → Z2 Multi-solid STEP export — **S kernel + S app** ✅ done

*Kernel:* add `exportStepMulti(solids: Vec<u32>)` (or widen `exportStep`)
in `crates/wasm/src/bindings/io.rs:327` — `write_step` already accepts the
slice. Conventional-commit PR with a two-solid round-trip test.
*App:* replace the multi-solid branch (`exact.ts:3723-3758`) with the new
binding; delete `getStepCombiner` (`exact.ts:2312`) and
`combineStepSolids` (`occt-step.ts:2119`).
*Acceptance:* `sample-export` multi-body STEP reimports as N solids in both
OCCT (while it lasts) and BrepKit; no `import('./occt-step')` fires for
documents without `imported-step`.

*Landed as esaueng/brepkit#36 + the app commit.* It also turned up a latent
writer bug: the `ADVANCED_BREP_SHAPE_REPRESENTATION` item list was emitted
with a trailing comma — `(#10, #20,)`, and `(#10,)` in the single-solid
case. ISO-10303-21 aggregates have no trailing comma, so strict readers
were entitled to reject **every file BrepKit had ever written**. It stayed
invisible because the only reader exercising the output was our own, which
is lenient there. Fixed and pinned.



---

## 2. M1 — Kernel parity (BrepKit work, parallel lanes)

### K0.1 STEP import/export fidelity — **L** (lane A) ✅ done

All in `esaueng/brepkit`, `crates/io/src/step/`.

**Priority correction.** Item 3's `SURFACE_CURVE` arm turned out to be the
hardest blocker in the whole programme, not a widening nicety: without it
BrepKit cannot read STEP produced by OpenCascade — which means it could not
read our *own* exports of imported bodies. Do item 3's `SURFACE_CURVE`
family first, then units, then the rest.

Also note the existing JS rewriter only rescales `CONICAL_SURFACE`
half-angles. It does **nothing** for length units, so an inch-authored STEP
file imports 25.4× wrong today, silently, on the BrepKit path. Item 1 is
therefore a correctness fix, not only a workaround-retirement.

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
*Acceptance:* ~~Z1.3 scenario pins "fillet-on-import", "boolean-with-import"
flip from mesh-fallback to exact~~; `brepkit_approx` census shows zero
mesh-fallback events on the corpus; volume assertions at 0.05.
*Risk:* genuinely hard numerics. Mitigate by keeping the bounded mesh
fallback as the safety valve (it stays; it just stops being *reached* for
these classes).

*Correction — the stated acceptance is falsified and K0.5 is deprioritized.*
Two of the three named pins no longer exist, and the premise behind them was
measured false rather than argued away:

- `boolean-with-import` never hit the mesh fallback. Both kernels produce 7
  faces with one cylinder on that scenario, which the pin recorded at the
  time it was written. K0.5 predicted a fallback there; the corpus says
  there is none.
- `boolean-with-import` and `pattern-boolean-with-import` have since been
  **retired entirely** — BrepKit converged onto their closed forms
  (`40·24·10 − π·5²·10` to 1e-12) and now agrees with OCCT, so the
  divergence the pins recorded is gone.
- `fillet-on-import` survives, but it reads 1.43e-5 *low* against the closed
  form, which is deflection residue on blended bands — not the
  analytic-faces-destroyed signature K0.5 exists to fix.

So the corpus found neither kernel falls back on the analytic×NURBS
scenario, and on the one file where they do differ BrepKit is the *more*
accurate of the two (0.1% vs OCCT's 1.38%). The XL numerics work in this
section is not justified by anything the corpus can currently measure.
Before restarting it, write a scenario that actually reaches
`phase_ff.rs:3024`'s `Ok(vec![])` and demonstrates a destroyed analytic
face — then this section has an acceptance test again.

### K0.6 Import validation + lineage parity — **M** (lane A tail) ✅ done

*Was:* "port OCCT's warning taxonomy and its imported-body topology witnesses
to BrepKit."

*Correction to the original spec, from Z1.3's measurements:*

1. **There were no imported-body witnesses to port.** `witnessedFaces`,
   `witnessedEdges` and `lineageNames` read zero and empty in every corpus
   record on *both* kernels. ADR-013 listed imported STEP alongside blends as
   `no lineage - hash fallback only`, which conflated a transition (a blend
   owes an output relation) with a root (an import owes nothing — there is no
   earlier body). Half of this item was build, not port.
2. **`meshQuality` is unusable as a validity gate.** It reports
   `isWatertight: false` with 50 boundary edges for `a-export-cone`, a valid
   analytic cone whose apex does not weld under independent per-face
   tessellation, and Euler characteristic 0 for the shipped bracket. Gating on
   it would refuse valid supplier files.
3. **Strict `validateSolid` only applies to a single-shell solid.** Its
   Euler-characteristic check assumes one closed shell, so every voided solid
   in the corpus reports exactly one error while being exactly what its file
   declares. Multi-shell solids are held to `validateSolidRelaxed` plus the
   adapter's own exact closure test.

*Done.* `imported-step-validation.ts` owns the taxonomy; closure and
manifoldness are read from the exact B-rep (`edgeToFaceMap` face-use counts),
not from a mesh. A shell that is not closed is rejected **per solid** and never
becomes a body — `f-hostile-open-shell` no longer imports as 666.67 mm³ — while
a closed solid that merely fails strict validation is kept and flagged, matching
OCCT's partial-success taxonomy. A file where some solids survive imports them
and names the dropped ones; only a file where nothing survives fails outright.
`inspectStep` answers in every case instead of raising, and carries the reason
in the value. Both adapters publish schema-v5 references on imported bodies
under one shared rule (see the ADR-013 amendment), so the corpus can assert the
two kernels give an imported body the same identity names.

*Acceptance:* met. On the corpus BrepKit produces no warning OCCT does not, and
where it does warn it names the entity or the defect where OCCT reports
"contains no solids"; the `f-hostile-open-shell` validity gap is closed in
BrepKit's favour and its pins are retired.

### Z4 Port the two OCCT-only direct edits — **M** (lane D, app-side) ✅ done

*Was:* `exact.ts:3298-3301` refused `resize-through-hole` /
`remove-face-feature`; OCCT implements them as compositions
(`occt-step.ts:517-820`).

*Correction to the original spec:* `fillThroughHole` does **not** cap rim
loops — it builds a cylinder of the hole's own radius along the hole axis,
**fuses** it in, and merges same-domain faces. No `removeHolesFromFace`
wire surgery was needed. BrepKit's `unifyFaces` is the `unifySameDomain`
equivalent, and its `defeature` takes no tolerance argument.

*Done.* Both kinds run on the BrepKit path and agree with OCCT
volume-for-volume; the cross-kernel agreement test drives the same edit
sequence on each kernel through that kernel's own fingerprints.
*How:* `classifyThroughHoleFace` replaces OCCT's face-orientation test with
point-in-solid probes — BrepKit reports every face as `forward`, so a bore
wall and an external boss are indistinguishable by normal, and the wall has
to be classified from which side holds material. `requireThroughHole` ports
the fail-closed source re-validation and its tolerances unchanged;
`fillThroughHole` is the plug fuse plus `unifyFaces`; `resizeThroughHole`
reaches OCCT's `(body ∪ bore) \ newBore` with one boolean instead of two,
which is the same set and sidesteps a plug fuse BrepKit often declines.

*Residual, both K0.3 — and both are kernel defects worth their own PRs:*

1. **The GFA boolean declines the plug fuse on most plate bodies** and falls
   back to a co-refined mesh (~100–180 planar faces, ~1e-4 relative volume
   error — too small for a volume gate to catch). Measured on a 30×30×10
   plate: degenerate at bore radii 2, 3, 5, 6, 8; survived only at 4. The
   adapter detects it by face count and refuses.
2. **`defeature` returns a wrong solid on non-trivial bodies.** Its doc
   comment says it "heals the resulting gaps by extending adjacent faces",
   but `crates/operations/src/defeature.rs` actually collects each kept
   face's polygon and plane and calls `assemble_solid` — a plane-set
   reassembly that cannot represent a concave body. Verified: on chamfer,
   pocket, boss, L-notch and plate-face cases it returns a solid that
   `validateSolid` flags with 2 errors. It is exposed through the wasm
   surface today. The adapter refuses the unsupported-body case by name and
   the wrong-solid case via strict `validateSolid`, but **the kernel should
   not be silently returning a broken solid at all** — this is the exact
   failure class the single-kernel programme exists to remove.

---

## 3. M2 — Single kernel

### Z3 STEP route flip — **M**, gated on K0.1 + K0.6 + Z1.3 green ✅ done

*Steps:* delete `containsImportedStep` routing so `imported-step` documents
rebuild on the BrepKit adapter (its `imported-step` case becomes
production); delete `normalizeStepPlaneAnglesForKernel` + its tests; keep
the corpus running both kernels until Z5.
*Soak:* at least one release with corpus + real-project imports green on
BrepKit while OCCT still exists behind a dev flag (vitest alias mechanism,
`vitest.config.ts:29-32`, already supports kernel swapping).

*Landed.* `createExactKernelAdapter` now returns `BrepKitKernelAdapter`
outright — `HybridExactKernelAdapter` had become a pure delegate, so it went
with the routing rather than surviving as a wrapper. Three findings worth
carrying forward:

1. **The angle rewriter was already inert.** Deleting
   `normalizeStepPlaneAnglesForKernel` changed not one number in
   `baselines/corpus.json`. The kernel reads `b-unit-degree-cone` at
   1047.1975511965977 mm³ — the closed form, and byte-identical to the
   radian control — with no JavaScript between the file and the reader.
   `test/step-import-compat.test.ts` now asserts that directly instead of
   asserting that the rewriter rewrote.
2. **The 22 MB was Z3's payoff, not Z5's.** The OCCT import was already
   dynamic, so once nothing reached it the asset stopped being emitted:
   `apps/web/dist` is 13 MB. Z5 recovers source lines, not bundle bytes.
3. **The app mirrored the routing in two places** and both had to move with
   it: the worker's `documentRequiresOcct`/`loading-occt` phase (it would
   have announced a kernel load that never happens) and `App.tsx`'s
   `kernel: 'occt'` capability, which gated solid offset on imported bodies
   behind `OCCT_SHARP_OFFSET_LIMITATION`. Solid offset on an imported body
   is now enabled, and correct: 12×22×32 exactly, agreed by both kernels
   (`test/exact-kernel-adapter.test.ts`, "keeps mirror, shell, and solid
   offset conformant on an IMPORTED body").

*What the flip costs users, stated plainly.* Blending an imported body now
goes through BrepKit's blender, which fits corner bands as B-splines where
the exact answer is a quarter cylinder — 4.63e-4 relative on
`fillet-on-import`, and the STEP re-export carries
`B_SPLINE_SURFACE_WITH_KNOTS` instead of `CYLINDRICAL_SURFACE`. This is
**not** caused by importing: BrepKit does the same on natively modelled
bodies, so it is a pre-existing K0.4 gap that imported documents have now
joined rather than a regression Z3 introduced. It is pinned in
`corpus-pins.ts` (K0.4) and asserted, not tolerated, in the e2e.


### Z5 Delete OCCT — **M**

Deletion inventory (from the usage map):
`packages/kernel-adapter/src/occt-step.ts` (~2,150 lines),
`occt-modeling-operations.ts`, `occt-lineage.ts` (27 KB) + their tests,
`test/step-import-compat.test.ts` and `test/topology-lineage-spike.test.ts`
(rewrite as BrepKit-only), `occt-wasm` from
`packages/kernel-adapter/package.json:19`, `ExactKernelKind = 'brepkit' | 'occt'` +
`OCCT_SHARP_OFFSET_LIMITATION` (`apps/web/src/lib/modelingOperations.ts:63-138`)
and the now-constant `kernel: 'brepkit'` App.tsx capability field,
cross-kernel assertions in
`exact-kernel-adapter.test.ts` and `kernel-seam.test.ts`.
*Inventory correction (Z3):* the `loading-occt` worker phase and
`documentRequiresOcct` are already gone — they described a reroute Z3
removed, so leaving them would have had the app announce a kernel load that
never happens. The `−22,088 kB wasm` payoff below is also already banked:
the OCCT import was dynamic, so it stopped being emitted the moment nothing
reached it. What Z5 still recovers is ~4,000 lines of source and one
behaviour to reason about.
Docs: amend ADR-009/ADR-010, `capability-matrix.md`,
`performance-baseline.md`. (README's kernel prose and the architecture
diagram were corrected in Z3, when they stopped being true.)
*Inventory correction:* `apps/web/vite.config.ts` no longer carries an OCCT
manual chunk — that line is already gone. Verified: after Z2, the only
remaining production importer of `./occt-step` is `getOcct` behind
`containsImportedStep`, so Z3 is genuinely the last gate and Z5 is then
mechanical.
*Payoff:* one code path. The −22,088 kB wasm (−7,100 kB brotli) landed at
Z3, when the last reachable importer went away.
*Rule:* this lands only after Z3's soak; revert path is `git revert` of one
PR (keep the deletion atomic).

*Z5 landed (2026-08-01). Four more inventory errors, one of them a
contradiction the inventory could not have satisfied as written:*

1. **The inventory contradicts its own correction.** It lists `occt-step.ts`
   for deletion while the correction below requires the corpus's cross-kernel
   comparison to keep working, and `corpus.spec.ts` runs
   `OcctStepKernelAdapter` live on every corpus file and every
   import-modeling scenario. Both cannot hold. Resolved by RELOCATION, not
   deletion: the cluster moved verbatim to `test/parity/occt-reference/` and
   `occt-wasm` moved from a dependency of `packages/kernel-adapter` to a root
   **devDependency**. The production adapter is single-kernel and nothing
   shipped can reach OpenCascade; the corpus is untouched and its baselines
   did not move. The adapter also stopped declaring `implements
   ExactKernelAdapter`, so it cannot be mistaken for a kernel the app could be
   pointed at.
2. **`test/step-import-compat.test.ts` is already BrepKit-only.** It contains
   no OCCT reference at all — nothing to rewrite. (`topology-lineage-spike`
   did need the treatment: OCCT half removed, BrepKit half and
   `verifyCompleteBrepEvolution`'s set equality kept intact.)
3. **The `−22,088 kB already banked` claim is right about the WASM and wrong
   about the bundle.** Verified by build: before Z5, `apps/web/dist` emitted
   no OCCT asset — but `grep -i occt apps/web/dist` still hit, because
   `assets/index-*.js` carried `OCCT_SHARP_OFFSET_LIMITATION` and the
   `capability.kernel === 'occt'` branch. Z5 removes 321 bytes raw / 150 gzip
   and, more usefully, makes the count of bundle files mentioning OpenCascade
   zero. Numbers in `performance-baseline.md`.
4. **`ExactKernelKind` does not travel alone.** Deleting the union also
   retires `ModelingOperationCapability.offsetTopology`, whose only reader was
   the `kernel === 'occt'` guard, and the `offsetTopology: 'unknown'` argument
   beside the `kernel: 'brepkit'` one in `App.tsx`. Leaving it would have kept
   a capability field no code consults.

*What was actually recovered:* 4,462 lines deleted from
`packages/kernel-adapter` (2,130 `occt-step.ts`, 928 `occt-lineage.ts`, 679
`occt-modeling-operations.ts`, 725 of their tests) — relocated, not destroyed
— plus a net 346 lines (621 removed, 275 added back) of cross-kernel test
legs in `exact-kernel-adapter.test.ts`, `kernel-seam.test.ts`, and
`topology-lineage-spike.test.ts`. Each deleted comparison was replaced by the
absolute claim it stood in for (a closed form, a pinned count, a named
refusal), because "two implementations agree" is not evidence once one of them
is gone.

*Correction — decide what the corpus becomes before deleting the reference.*
This inventory removes `occt-wasm` and the cross-kernel assertions, but Z1.3's
corpus is built on running every file through **both** kernels and comparing.
Deleting OCCT does not just delete a code path; it deletes the instrument that
made removing a second kernel safe in the first place, and the pins are the
record of that comparison.

That is survivable but it must be a decision, not a side effect. After Z5 the
corpus can still measure BrepKit against **recorded baselines and closed
forms**, which is what actually caught the defects that mattered: the malformed
trailing comma, the 25.4× unit error, the dropped voids, the filled bores. None
of those needed a second kernel — they needed a known-good answer. What is lost
is the ability to discover an *unknown* divergence, which is what retired the
three volume pins in this file.

Concretely, Z5 should keep `occt-wasm` as a **devDependency** for the corpus
job alone, and delete it only from the production adapter. That preserves the
comparison for as long as it is cheap and keeps the shipped app single-kernel,
which is the actual goal. If the corpus job later becomes a maintenance cost,
retiring the comparison is then its own small, reversible decision rather than
a clause buried in a deletion PR.

---

## 4. M3 — Workaround retirement (Z6) and capability exposure (Z7)

### Z6 itemized

| Item | Retire when | Work |
| --- | --- | --- |
| ~~`tryExactAnalyticCylinderRimFillet`~~ | ~~K0.4 phase 2~~ ~~the kernel builds a convex cap-rim blend at f/r ≥ 0.5~~ | **✅ done** — deleted once the pin carried brepkit#50; its test survives as a kernel regression |
| `tryExactAnalyticCylinderCapOffset` / `tryExactCoaxialCylinderCut` | ~~K0.5 + a kernel coaxial-cut fast path~~ ~~**GO now — both justifications measured false**~~ **NO-GO — both are load-bearing; the "measured false" reading was a sampling error, see below** | leave in place; file the two kernel defects — **S** each once fixed |
| Boolean distrust harness (`boolean-result-validation.ts`) | after N releases with zero census failures on the corpus post-K0.5 | demote to debug assertion behind a flag — **S** |
| STEP text rewriter (`step-import.ts`) | K0.1 | delete in Z3 — **S** |
| Viewport geometric edge-walk (`edgeChain.ts`) + chord-midpoint snaps (`topologySnaps.ts`) | adjacency/exact-curve publishing (below) | rewrite walk topologically — **M** |

**Adjacency + exact-curve publishing (the one new protocol):** extend the
worker topology payload so each edge carries `adjacentFaceHashes:
number[]` and `curve: { type, params }` (line/circle, **not** ellipse or
nurbs) — viewport consumes it for edge-run walking, arc midpoints, and future
measure tools. Split it: **W1 adjacency = S ✅ done (#96)**, **W2 curve = M
✅ done**, **W3 snaps fix = S after W2 — in flight**, **W4 `edgeChain`
rewrite = M–L — in flight**. Kernel-independent, can start any time.

*W4's prep slice landed ahead of the rewrite and changed what the rewrite has
to do.* It publishes `vertexIds: [number, number]` — the kernel's own vertex
handles renumbered, start then end in the edge's own direction, deliberately
**not** sorted. Three things it settled:

- **The premise blocking W4 was false.** `getEdgeVertexHandles` already exists
  on `BrepKernel` and is already used in production in `exact.ts`
  (`selectedEdgesShareVertex`, `selectionTouchesBlendFace`). There was no
  vertex identity to derive and no kernel request to file. The claim at item 5
  below — "BrepKit publishes no edge→vertex map" — was wrong.
- **Deriving identity from geometry was measured and rejected.** Across 78
  solids, 1,767 vertices and 2,977 edges: quantizing the *exact* positions at
  the ADR-011 1e-6 quantum gave **zero** false splits, but quantizing the
  *display polyline* — the only derivation the viewport could actually run —
  gave **73**, every one on a closed edge. A closed edge's polyline begins a
  quarter turn from its own vertex: 10√2 on an r10 cylinder, **63.64 units**
  on the flange's r45 rim. That is missing information, not a tolerance.
- **The chamfer trap below is confirmed to the decimal.** Worst rim kink on a
  3 mm chamfered 20×20×10 box is exactly **45.000000°**, and the run collapses
  from 8 edges to 1 at 45°. The 50° cone stays; whether a chamfer band is one
  run is a product decision, and the rewrite preserves today's answer.

*W1 landed as the S it was estimated at — one field, two files, no protocol
change — and settled two things by measurement rather than argument:*

- **The sphere witness collision is real and is now pinned by a test.** All of
  a sphere's faces publish one hash, so *every* sphere edge reports a single
  distinct adjacent-face hash — including the equator, which genuinely divides
  two patches. Adjacency therefore cannot distinguish the hemispheres. This was
  recorded as open question O3; it is closed, and the test turns red if the
  collision ever goes away so the change gets a deliberate look.
- **Publishing cost nothing extra.** `edgeToFaceMap` was already parsed per
  solid and used only to derive `displayRole`, and the face loop already
  computed each hash, so W1 is a `Map` filled in a loop that was running
  anyway. The parity baselines did not move: the corpus compares a fixed metric
  map rather than walking arbitrary `BodyTopology` fields, which also confirms
  a BrepKit-only payload is corpus-safe and `occt-step.ts` can be skipped.

*Corrections — five claims in the original wording were measured wrong, two
of them load-bearing:*

1. **`getEdgeCurveParameters` cannot source the curve record.** It returns the
   *underlying* curve's domain, not the edge's trim. Measured on a 20×20×10 box
   filleted at r=3: a quarter arc of `edgeLength` 4.712389 (= 3π/2) reports
   domain `[0, 6.283185]` — the full period — and evaluating at that domain's
   midpoint returns the edge's own **end vertex**. Implementing this line
   literally ships an authoritative-looking curve record that is wrong for
   every fillet and chamfer arc in the product. Use `measureCurvatureAtEdge`
   gated on `getEdgeCurveType(edge) === 'CIRCLE'` (14× cheaper than
   `getNurbsCurveData`, and does not throw on the zero-length degenerate edges
   a torus carries). Publish nothing analytic for ELLIPSE —
   `measureCurvatureAtEdge` is wrong for those by a factor of ~1e12.
   *Scope settled by census:* every edge in all 18 corpus fixtures is `LINE`
   or `CIRCLE`. **There is not one `BSPLINE_CURVE` edge in the corpus**, so
   the curve record needs no spline branch for anything we currently measure —
   carry the type and stop there. `getEdgeCurveType` itself is trustworthy:
   every `LINE`-typed edge across the corpus has arclength equal to its chord
   to 1e-6 relative, so it does not under-report curvature. (Worth stating
   because the census *looks* alarming at a glance — `a-export-sphere`
   reports 32 `LINE` edges and no arcs, and `e-nurbs-fillet-plate` reports 24
   `LINE`. Both are real: those edges are genuinely straight.)
2. **`exact.ts:252` is not adjacency.** That is `analyticSurfaceRecord`, a
   *face* surface-params helper. Real adjacency is `exact.ts:4451`
   (`kernel.edgeToFaceMap`), and `occt-step.ts:116` (not `:115`). This is good
   news: adjacency sits two loops above the edge-record push, with face
   `handle` and `hash` already in scope.
3. **`[number, number]` is the wrong type.** Seam edges list the same face
   twice, and flagged non-manifold STEP imports *are* built into bodies
   (`imported-step-validation.ts` marks them `flagged`, not `not-a-solid`), so
   a fixed pair truncates silently. Use `number[]`, **sorted** —
   `edgeToFaceMap`'s order is kernel-determined and the corpus digests hashes
   after sorting, so a nondeterministic order would pass every existing test
   while making rebuild output non-reproducible.
4. **There is no worker protocol version to bump.** The only `version` on
   worker messages is `document.version`, used as a staleness discard. The
   worker ships from the same Vite bundle with no service worker, so a
   mismatched client is structurally impossible. Use optional fields, exactly
   as `displayRole?` did across 14 files with no schema change. The one real
   staleness window is a *persisted* `derived` from IndexedDB, which optional
   fields handle.
5. **Adjacency alone does not suffice for the `edgeChain` rewrite.** Verified
   on a plain box: two edges on opposite sides of the top face share that face.
   The walk also needs vertex incidence, which W1 does not deliver — which is
   why W4 is M–L rather than part of one M. ~~BrepKit publishes no edge→vertex
   map, so the adapter must derive vertex identity itself.~~ **False, and the
   correction is above:** `getEdgeVertexHandles` exists and the adapter was
   already calling it. The derivation this predicted would have been the wrong
   thing to build, not merely extra work.

*Trap, before anyone tidies `edgeChain`:* its 50° cone is **load-bearing for
chamfers**, not a leftover. A 20×20×10 box chamfered 3 mm on its four vertical
edges has a worst rim kink of exactly 45°, and the run collapses from 8 edges
to 1 at a 44° tolerance — while the UI advertises "Fillet or chamfer applies to
all of them." Pure G1 tangency is the wrong rule. The docstrings in
`edgeChain.ts` and `topologySnaps.ts` justifying it ("the kernel hands the
viewport a fillet arc as a two-point polyline") are separately wrong: at the
app's real display deflection a quarter arc arrives with **28 points**, not 2.

~~*The other two cylinder workarounds are GO, and were never really K0.5's to
gate.*~~ **Both are NO-GO. Each docstring claim reproduces on the current pin;
the "neither reproduces" reading came from probing one point per claim, and in
both cases that point was on the working side of a sharp boundary.** The
original wording is kept below with the correction under each, because the
shape of the mistake is the lesson: a single passing sample is not a sweep.

- ~~`tryExactCoaxialCylinderCut` says the generic boolean "falls back to a
  triangular B-rep when a smaller coaxial cylinder opens exactly onto either
  cap". It does not.~~ **It does — the old probe was a thick-walled tube.**
  The through tube at `r_out 10 / r_in 4` does come back analytic: 4 faces —
  2 cylinders and 2 planes — at 5277.875658 against
  `π·10²·20 − π·4²·20 = 5277.875658`, and blind bores give 5 analytic faces at
  5780.530483 against `6283.185 − π·4²·10`. Both numbers reproduce exactly.
  But that tube has `wall/r_out = 0.6`. Scanning the wall ratio on a blind
  bore (`r_out 32.9, h 25, depth 21.5`) finds three regimes, scale-invariant
  from 1e-3 to 1e3 — it is the *ratio* that decides, not the size:
  - `wall/r_out ≳ 0.09`: clean. 5 faces, 6 edges, watertight, exact to 3e-16.
  - `0.018 ≲ wall/r_out ≲ 0.088`: **5 analytic faces but 7 edges.** The outer
    wall's seam is split in two at the bore-floor height (`3.5` and `21.5`
    against a `25` wall), leaving a T-vertex that no face on the other side
    matches. `validateSolidRelaxed` is 0 and `volume()` is right to ~1e-12, so
    both of the adapter's gates pass — but the tessellation carries **8
    boundary edges and is not watertight at any deflection**, which is an STL
    export defect the B-rep checks cannot see.
  - `wall/r_out ≲ 0.015`: the triangular fallback the docstring names, alive
    and well — **500+ planar faces**, volume off by 5.1e-4 relative.

  The shipped bottle-cap fixture is `wall/r_out = 2.5/32.9 = 0.076`, in the
  middle of the T-vertex band. Deleting the workaround turns that test red on
  edge count (7 against 6) and ships a leaking mesh. The workaround's revolved
  section is watertight, 6 edges, and exact to 9.7e-16 on the same fixture.
- ~~`tryExactAnalyticCylinderCapOffset` says repeated cylindrical resizes make
  the generic cap boolean "accumulate a mismatched circular boundary and fail
  its exact volume gate". Eight consecutive `pushPullFace` rounds of +1.0 hold
  at 3 faces throughout.~~ **They do — and every one of them grows the solid.**
  The eight `+1.0` rounds reproduce exactly: 3 faces, `validateSolidRelaxed` 0,
  `π·10² = 314.159265359` gained per round with no drift, `volume()` equal to
  `π·r²·h` to 0.0e+0 at every step. **Negative offsets on the top cap are
  broken across the board**, and the shipped `offset-face` test uses `-4.5`:
  - `r 6.5, h 30.25`, top cap: every offset in `+0.001 … +100` is exact and
    3-faced; every offset in `−0.1 … −20` **throws the kernel's own gate** —
    `push/pull produced volume 3409.2168829885813, expected 3417.916423495011`
    at `−4.5`. Same at `r 5 h 20`, `r 2 h 10`, `r 6.5 h 20`, `r 6.5 h 30`.
  - `r 10, h 30`, top cap, offsets `−0.001 … −20`: no throw, but the result is
    **65 planar faces and no cylinder at all** — silently faceted, 1.66e-3
    relative error, and `validateSolidRelaxed` 0 and watertight, so nothing in
    the adapter notices. `r 50 h 100` gives 422 planar faces. This is the
    failure mode the retirement rule exists to catch.
  - It is not scale-invariant either: `r 6.5s, h 30.25s, offset −4.5s` throws
    at s = 1e-3, 0.1 and 1, returns 482 planar faces at s = 10, and hits
    `mesh boolean work limit exceeded` at s = 1e3.
  - The **bottom** cap is fine in both signs (3 faces, exact), so this is an
    asymmetry between the two caps of a `makeCylinder`, not a shrink/grow rule.

  Deleting the workaround turns the shipped test red with a user-facing
  `Feature "Lower top": invalid input: push/pull produced volume …` warning.

**Two kernel defects to file, both blocking their retirement:** (1) `cut`
leaves a T-vertex on the outer wall's seam when a coaxial bore opens on a cap
of a thin-walled cylinder — analytic and B-rep-valid, but not mesh-watertight;
(2) `pushPullFace` on the **top** cap of an analytic cylinder with a negative
offset either fails its own volume gate or returns a faceted body, where the
bottom cap is exact for the same move.

**These differ from Z6.1 in a way that matters.** Z6.1's workaround ran only
*after* `kernel.fillet` failed, so it could never override a kernel success and
deleting it removed only capability. These two are tried **first** —
`tryExact… ?? generic` — so they *pre-empt* the general path wherever they
apply. That is still a reason to want them gone: they are a second answer to
the same question, free to drift. It is not a reason to delete them while the
first answer is wrong, and right now it is.

Sequencing: gate both on the two kernel defects above, then re-run the wall
ratio and offset sign sweeps rather than a single point.

*Z6.1 was NO-GO, then GO, and is now **done** — the kernel gap it waited on was
closed by brepkit#50 and the workaround is deleted.* Re-verified against the
pin before deleting, one rim and both rims, at r = 2, 3 and 10 with f/r from
0.1 to 0.99 and at scales 1e-3, 1 and 1e3:

- One rim builds for every `0 < f < min(r, h)`, both rims for every
  `0 < f < min(r, h/2)` — wider than the workaround's own guard, which also
  required `f < h` (resp. `2f < h`). Outside that the kernel throws
  `radius-too-large: … max=<value>`, carrying the limit, so `f = r`, `f = h`
  and `2f = h` all refuse in a form the adapter can dress up.
- Every success is analytic and watertight: **4 faces {2 plane, 1 cylinder,
  1 torus}** for one rim, **5 faces {2 plane, 1 cylinder, 2 torus}** for both,
  χ = 2, zero free and zero non-manifold edges, matching the Pappus closed form
  to ≤ 2.4e-16 at all 30-plus sample points.
- The workaround was already unreachable on this pin — bypassing it changes
  nothing in the suite — and its output was *worse*: a 64-segment polyline
  revolve, i.e. a fan of cone faces standing in for the blend.

Its test survived as a kernel regression and gained face-count and
surface-type assertions, plus two new regressions covering the previously
NO-GO upper half of the range and the typed refusal at `f = r`. The diagnosis
below is kept because it is what the retirement trigger should have said all
along, and because the K0.4-phase-2 correction in it still stands.

The fix was smaller than the diagnosis implied, and worth recording: the guard
capped the inward case at `r_c/2` on the reasoning that a horn or spindle torus
"is invalid as a fillet surface". The torus is; **the face cut from it is not.**
The band spans only `|v| ≤ π/2`, and a spindle crosses its own axis only where
`major + minor·cos v < 0`, i.e. `|v| > arccos(−major/minor) ≥ π/2` for every
`major ≥ 0` — disjoint from the quarter actually used. No trimming work was
needed. Deleting one line made every radius work, exact to 1e-15 across the
sweep. **Two new defects came out of it**, both left for their own lanes: a
blind hole's floor rim (the *other* geometry `inward` covers) LOSES 7.933 mm³
where it must ADD 3.744 while passing `validate_solid`, and a cone cap rim has
no analytic path at all because `plane_cone_fillet`'s convex branch needs the
apex on the material side, which a frustum's small end never satisfies.

*The original NO-GO measurement, for the record.*
BrepKit's convex cap-rim fillet succeeded iff **f/r < 0.5** and threw
`partial-result` at f/r ≥ 0.5 — verified scale-invariant at r = 2, 3 and 10,
with f/r = 0.4999 succeeding and 0.5000 failing in every case. The blend torus
is `{major: r−f, minor: f}`, so at f = r/2 it degenerates and the kernel cannot
build a horn or apple torus; `chamfer` is unaffected because its band is a
cone. The workaround's own guards admit `0 < f < r`, so deleting it converts
the **entire upper half of the geometrically valid radius range** into a
user-facing "Try a smaller radius". K0.4 phase 2 was the *concave hole-rim*
assembler — that landed and is exact (bored plate, f=1 top rim: 8 faces,
volume 28701.23908 against Pappus 28701.23908) — but it runs on a 7-face body
that `readAnalyticCylinder`'s 3-face gate rejects, so it is not evidence about
the case this workaround serves. ~~**Kernel request to file:** build the
horn/apple torus for a convex circular rim at f ≥ r/2, or at minimum return a
typed `RadiusTooLarge` rather than a bare `partial-result`.~~ **Both landed in
brepkit#50.**

*Which volume to trust, measured — the standing note said `volume()` reads
0.3% high on a boss crossing a wall while `massProperties` matches. **That does
not reproduce on this pin**: a `r5 h40` boss through a `60×60×10` plate gives
38356.194490192 from both routes against a closed form of 38356.194490192,
1.9e-16 and 9.3e-15 respectively. The disagreement is real but sits elsewhere,
and in the opposite direction.*

- **`massProperties` is wrong on a trimmed torus face.** On a cylinder with one
  cap rim filleted it under-reports by 2%–12%, growing with f. The error has a
  clean closed form of its own: it books the removed corner as `(2πr_c²/3)·f`,
  linear in f, where the true removal is `O(f²)` — confirmed at r_c = 2 and 10.
  `volume()` matches Pappus to ≤ 2.4e-16 across the whole sweep and is
  **deflection-invariant** (identical to 12 digits from deflection 1 down to
  1e-4), so it is not tessellating. Untrimmed primitives are fine through both
  routes, *including a whole torus* (1776.528792 against `2π²Rr²`, 7.3e-15).
- **`volume()` ignores an inner shell.** A `r4 h8` cavity fully enclosed inside
  a `r10 h20` cylinder reads 6283.185307 — exactly `π·10²·20`, the outer solid
  as if it were solid — against a closed form of 5881.061448. `massProperties`
  gets it right to 2e-13. Scale-invariant at 1e-3, 1 and 1e3. The adapter reads
  `kernel.volume` everywhere and never calls `massProperties`, so **any body
  with a fully internal void currently reports its volume as if the void were
  filled.** Not this lane's to fix, but it is a live product bug.

So neither route is a default. Use `volume()` against a closed form for
anything with a blend band; use `massProperties` for anything with an internal
void; and never use their agreement as evidence, since on the two cases above
they disagree by 9% and 7% respectively and each is right exactly once.

### Z7 Feature exposure (each: document-core feature/params + command +
UI form + AI-contract op + tests)

*Correction:* "worker case" was in this checklist and is not a cost —
`geometryWorker.ts` is document-level sync/export with **zero** per-feature
branches. The rebuild switch is the `featureKind` switch in `exact.ts`'s
`build` (line numbers in this row went stale during Z7; find it by name).

| Feature | Kernel binding | Extra notes | Est |
| --- | --- | --- | --- |
| ~~Partial revolve **angle**~~ | ~~`revolve(..., angleDeg)` exists; app hard-codes 360~~ | **landed (Z7)** — shipped with ADR-011 hash-only lineage; three defects found, see below | **S** |
| Revolve axis-by-selection | — | separate item; blocked on giving revolve a region path first | **M–L** |
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

**Partial revolve: the kernel is fine; lineage is the cost.** The obvious risk
— that a partial revolve returns an open shell needing app-side caps — does
not happen. Measured on an r=2..3, h=1 annulus about +Z: 90° / 180° / 270° /
359° all give **one closed shell**, `validateSolid` 0, watertight tessellation
with zero boundary edges and χ=2, and volumes matching the closed form to all
printed digits (90° → 3.926991). Cap planes are present in the surface params.
The `(0, 360]` guard is enforced and non-integer angles work.

What is *not* free is ADR-013 semantic lineage, and it breaks two ways:

- `expectedCircleWitness` hard-codes `closed: true` and `length: 2πr`, but a
  partial revolve's corresponding edges are **arcs** — an `EdgeWitnessV1`
  variant that can never satisfy it. Every profile-vertex edge role fails at
  any angle < 360.
- BrepKit splits swept faces at 90° boundaries — 6 faces at ≤90°, 10 at
  91–180°, 14 at 181–270°, 18 at 271–359.9°, 4 at 360° — with duplicate
  analytic params across the pieces, so `addUniqueSemanticAssignment`'s
  exactly-one-match requirement goes ambiguous above 90° too.

Net: partial-revolve bodies fall back to ADR-011 hash-only references instead
of ADR-013 names. Circular profiles are exempt (a torus does not
quadrant-split). **Shipping the angle with hash-only lineage is a legitimate
call and keeps this at S — but make it deliberately, not by discovering it
later.** Also gate or warn on fillet: it fails on 12/12 edges of a 90° wedge
while succeeding on 4/6 of the same full revolve, and users reach for fillet
immediately after making a wedge.

### Z7 partial revolve as built, and the three things this row got wrong

Shipped as `FeatureData.revolve.angleDeg`, optional, absent meaning a full
turn. The hash-only fallback is named in code
(`PARTIAL_REVOLVE_HASH_ONLY_REASON`) and in an ADR-013 amendment; the circular
exemption is implemented and covered; a full turn keeps all four face roles and
all four profile-vertex edge roles, asserted rather than assumed. Rollout flag
`AI_PATCH_PARTIAL_REVOLVE_ENABLED` gates the **field** rather than the
operation, since `add_revolve` itself has shipped for a long time.

Everything this row asserted about faces, volumes, closure and the `(0, 360]`
guard reproduced exactly. Three corrections and one new defect:

*χ is not 2 for a full revolve, and the check that said so would have been
"fixed" by loosening it.* A wedge is a topological ball, χ = 2. Sweeping the
same off-axis profile a full turn closes it onto itself and gives a **genus-1**
solid, χ = 0. Both are asserted per case.

*The fillet failure is worse than "12/12 refuse", and part of it was a hash
bug.* Two of the wedge's twelve edges were not refused at all — they came back
"A selected edge no longer exists", because the hash `BodyTopology` publishes
and the hash `edgeHandlesByFingerprint` resolves are computed by different
sorts. `edgeSignatureOf` orders an open edge's endpoints by **raw** coordinate,
`edgeWitnessOf` orders them by the **quantized** coordinate. They agree until
two endpoints tie after quantization on the leading axis — which is exactly
what a wedge's cut-plane edges do, sitting at a numerical zero of ~1e-16. Those
two edges were unselectable for every downstream feature, not just fillet.
Fixed additively: `edgeHandlesByFingerprint` now registers the witness hash
alongside the fingerprint and the legacy scheme, so no persisted hash changes.
With that fixed the count is a true 12/12 refused, at every radius from 0.4
down to 0.002 — so the pre-existing "Try a smaller radius" advice was false at
every radius. `edgeModifierFailureMessage` now names the wedge, and only after
the size ladder has failed.

*Scale invariance does not hold at 0.001× for a partial revolve.* At 1× and
1000× the volume matches the closed form to 1e-16. Below roughly 5e-3 model
units it goes **low** by a fixed relative amount per sweep angle — 1.30e-5 at
45°, 1.70e-5 at 90°, 2.76e-5 at 180°, 3.45e-5 at 270°, 3.43e-5 at 359° —
identical at 2e-3, 1e-3 and 5e-4, so it is a threshold rather than drift. The
**full** revolve of the same profile stays exact to 4e-16 at 1e-3, and
cylinder, sphere and torus primitives are exact to 1e-16 there, so this is
specific to the partial sweep. Signature of a chord under-approximation of the
swept arc bounded by an absolute tolerance inside the kernel — the same class
as #53's `wire_polygon_sampled`, which was fixed at ordinary scale. Recorded as
a characterization test; not app-fixable.

*New, and the one that should block enabling this by default: **every partial
revolve comes back with a reversed shell.*** The solid is valid and its volume
is right, and the mesh is closed and consistently wound — but wound **inward**.
Signed mesh volume is negative at 45°, 90°, 180°, 270°, 359° and 359.99°, and
positive at exactly 360. `writeAsciiStl` computes facet normals from the
winding, so a wedge **exports to STL inside-out**: measured −3.914 signed
volume on a 90° wedge against +15.391 for the full revolve of the same profile.
This is a BrepKit `revolve` orientation bug. It is deliberately not patched
app-side — flipping a shell by a signed-volume heuristic in the middle of the
lineage path is precisely the plausible-but-wrong change this document exists
to prevent — but it is characterized so it cannot regress silently.

*Axis-by-selection is separate and starts blocked.* `RevolveAxis` is
`'horizontal' | 'vertical'` — the sketch basis through the plane origin — and
nothing in the codebase supplies a *direction* from a selection. The
cheap-looking route (a construction line as the axis) is unsafe as things
stand: revolve reads `sketch.objectIds[0]` blindly and never got the region
path extrude has, so adding a construction line to an existing revolve's
sketch could **silently change which object is the profile and corrupt saved
documents**. Give revolve a region path first.

---

## 5. M4 — Competitive kernel (K1, parallel lanes after M1)

| Lane | Work | Key sites | Est |
| --- | --- | --- | --- |
| Blend | chamfer walker (`chamfer_builder.rs:377` "walker not yet integrated"); torus/NURBS blend pairs (`analytic.rs:31-36,192-343`); trimming beyond planes (`builder_utils.rs:203`); setbacks, face-face, full-round; promote variable radius off deprecated v1 sampling. **Cap-rim radius range and the seam-chord defect landed in #50** — see Z6.1. Two new items it surfaced: the concave blind-hole floor rim, and cone cap rims having no analytic path | `crates/blend` | **XL** |
| Offset | ~~cavity shells (`offset/lib.rs:90`)~~ and ~~arc joints (`arc_joint.rs:16`)~~ **both landed in #53**; self-intersection removal (`self_int.rs:20`) and NURBS intersection (`inter3d.rs:156`) still refuse — see below | `crates/offset` | **M** remaining |
| Boolean | same-domain full merge (`same_domain.rs:14`), off-axis cones (`boolean/mod.rs:1413`), **non-planar coincident contact (`:914`) — reproduction below, do this first**, volume-accuracy fix | `crates/algo`, `operations/boolean` | **L** |
| Types | add `EdgeCurve::{Hyperbola, Parabola}` (unblocks `convert_to_elementary`), `FaceSurface::{OffsetSurface, SurfaceOfRevolution, SurfaceOfExtrusion}`; give `Plane` a UV parameterization to kill plane special-casing | `crates/topology`, ripple across algo/blend/io | **XL**, stage by variant |
| Sweep/loft | implement `SweepCornerMode::Round` (today silently degrades, `sweep.rs:1185`); non-planar caps with holes / >4 edges (`cap.rs:141-146`); draft on non-planar faces | `crates/operations` | **L** |
| Tessellation | close the planar inner-wire TODO (`tessellate/planar.rs:18` — verify against `tessellate_watertight.rs` first; may be stale) | | **S** |
| Hardening | fuzz booleans/blends with **structured generators** (random primitive trees + transforms; invariants: closed shell, volume ⊆ operand bounds, determinism, fuse/cut idempotence) — I/O readers are fuzzed, engines are not; extend `mutants.toml` to `blend`/`offset`/`operations`; ~~keep the `brepkit_approx` census as a CI metric~~ — **it is not one today, see below** | `fuzz/`, `mutants.toml` | **M–L** landed, see below |

**The Hardening lane landed as brepkit#54, and corrected two things this row
asserted.**

*`brepkit_approx` was never a CI metric.* Checked rather than assumed:
`approx_census.rs` exists in `crates/operations/examples/`, its probes are
live at 7 sites across blend, offset and operations, and 4 `.claude/skills`
documents tell you to run it — but **nothing in `.github/workflows/` or
`scripts/` invokes it.** It is a manual local tool. "Keep it as a CI metric"
was wishful; wiring it is its own worthwhile change.

*Extending `mutants.toml` alone would have been inert.* `mutants.yml` passes
explicit `--package` flags and cargo-mutants **intersects** those with
`examine_globs`, so a glob for an unnamed package is never reached. The
workflow has to name the crates too. Examined surface goes from ~48k lines to
~122k; job budget 60 → 180 min.

*The measurement oracle was also wrong in the original design*, in the same
way it was wrong everywhere else in this document: route agreement between
`mass_properties` and `solid_volume` was to be the primary check, on the
grounds that the routes are independent. **They are not** — they meet in
`integrate_face`. #53's open-arc chord error moved both by the same 2.0 % and
the check saw nothing. The primary oracle is now a closed form derived
outside the kernel; route agreement is kept and documented as a weak
secondary signal that catches a defect confined to one route (#46) and
nothing in the shared integrator.

Two defects came out of the first bounded runs, both open:

- **A point-tipped cone tessellates to a mesh that is not closed.**
  `make_cone(r=3, top=0, h=1)` at `diag*4e-5`: 416 triangles, **418 boundary
  edges**, 420 vertices where 210 suffice. The cone face and the base plane
  each emit their own copy of the 209-point base circle and the two are never
  merged. A frustum at the same deflection is watertight, so the shared-edge
  pool works for an ordinary circle and not this one. ~~`MERGE_GRID` is a
  fixed absolute `1e-7` … here 209 of 209 split.~~ **That was the wrong
  suspect and the fix lane said so — see the correction below.** Watertight
  at 0.001×, open at 1× and
  1000×. **No measurement oracle catches it:** `solid_volume` returns
  9.42477796076938 against an exact `πr²h/3` of 9.42477796076938. The volume
  is right and the mesh is wrong — the mirror image of #52, which passed
  watertightness with the bore filled *and* the bore walls absent, two errors
  cancelling. This is why both rungs are checked.
- **A fillet reads 55.6 % apart between the two routes** (312.932080729 vs
  704.367776927). Because they share their integrator, a gap that size means
  one route alone is badly wrong; #53 accounts for a couple of percent. Plus
  five not-watertight artifacts across `draft`, `fillet` and `shell`, one with
  2 non-manifold edges. Not triaged — the PR is the harness.

*A false positive worth recording, because it was the harness's and not the
kernel's.* The first campaign reported `V−E+F = 4, genus −1` on a fuse of two
boxes. Euler's formula is **per closed surface**: a fuse of operands that do
not touch is a correct two-shell result whose aggregate is `2n`, not 2. The
census now partitions faces into connected components by shared edge and
tests each — also strictly sharper, since summing lets a genus error in one
shell cancel against another.

*A third finding, and the sharpest one, came from the lane auditing its own
oracle rather than the kernel.* **`transform_solid` refuses every uniform
scale ≤ 0.00464.** It rejects any matrix whose *determinant* falls under
`Tolerance.linear` (1e-7) — but a determinant is a **volume** ratio and that
tolerance is a **length**. The comparison is dimensionally wrong. For uniform
scale it collapses to `s³ ≤ 1e-7`. Measured: 0.0047× transforms, 0.0046× and
0.001× are refused — a millimetres-to-metres conversion sits squarely in the
refused band. Same absolute-tolerance pattern as #51, with a dimensional
error on top. It also meant the lane's own scale oracle was **silently inert
on half of every case**: the exact failure mode it was built to hunt, living
inside the hunter.

*OpenZCAD's exposure is nil today, and that was checked rather than assumed.*
Every `copyAndTransformSolid` call site in `exact.ts` (683, 1182, 2958, 3079,
3093, 3103, 5034, 5071) is a pattern or a mirror — rigid, `det = ±1`. The
`× 1000` occurrences at 1587–1589 and 1683–1685 are hash coordinate
quantization, not transforms. STEP unit conversions are inch→mm (25.4) and
m→mm (1000), both greater than 1. It would bite a future **scale-body**
feature or any mm→m export path, so it must be fixed upstream before either
ships.

**A decision this lane surfaced, recorded so it is deliberate.** Adding the
engine targets to the scheduled `fuzz.yml` matrix makes that job **red**.
Landing it red is the right call — hiding a live defect to keep a dashboard
green is precisely the habit this whole effort exists to break — but a
permanently red scheduled job trains people to ignore it, so the cone fix was
queued as the next kernel lane rather than left open indefinitely.

*Correction, and it undercuts the reason I gave rather than the decision.*
I wrote that the job is red **because the cone defect is real and open**, and
that landing the cone fix would shorten the window. **Both are false.** The
scheduled job's only recorded run (2026-07-26, `df532ee`) **predates #54**:
the matrix then held seven reader targets and no `boolean_tree` at all, and
what failed was **`ply_reader` and `glb_reader` crash artifacts**. So that
job was already red for unrelated reasons, the cone was never its cause, and
the cone fix does not turn it green. Those two reader crashes need their own
lane. The decision to land red still stands; the justification I attached to
it was simply wrong, and was asserted rather than checked.

### The cone defect: the mechanism, which was not the one suspected

Worth recording in full, because the framing pointed **one stage too early**
for the third time in this effort, and the real chain is instructive.

It is **not `MERGE_GRID`**, and not any merge tolerance: the closest pair of
vertices in the broken mesh is **2.25e-2** apart — four orders of magnitude
beyond `snap_tol`. There were no near-coincident vertices failing to merge.
What actually happens:

1. A pointed cone's lateral face has **one** closed rim circle plus a doubled
   degenerate seam to the apex, so `tessellate_revolution_band_shared`, which
   needs two rims, declines.
2. `tessellate_nonplanar_cdt` then returns `Ok` having emitted **zero**
   triangles — the seam collapses the UV boundary — so the caller rolls back
   to `tessellate_nonplanar_snap`.
3. Snap tessellates from the cone's **own** parametric grid and reconciles
   with the shared pool by proximity afterwards.
4. The cone surface's `u = 0` ray and the base circle's `t = 0` ray are
   **half a turn apart**: `make_cone` gives the base circle normal `+z` while
   the cone's axis runs apex→base (`−z`), and `Frame3::from_normal` derives
   opposite reference directions from those.

So the two rings coincide **only when the segment count is even**. At r=3,
h=1 and `diag*4e-5` the count is **209 — odd**, and every rim sample lands
exactly half a step (0.045) from its counterpart.

**The apparent scale-dependence was a second absolute constant, and it was
luck.** `tessellate::face` floors the segment count with
`max_radius.max(0.01)`, so the 0.001× copy takes 380 segments — even — and
closes by coincidence rather than by correctness. That is worth remembering
whenever a scale sweep shows one scale passing: passing can be an accident of
parity.

Fixed by `tessellate_cone_apex_fan_shared`, the one-rim sibling of the
two-rim band path, fanning the shared rim to the shared apex with no
length-carrying constants. Cone at 1× and 1000× goes 418 boundary edges → 0,
and a 1,800-case fuzz lattice goes **254 leaking → 0**, with the minimum
vertex separation unchanged at 2.25e-2 (so nothing was over-merged). Four
boolean combinations on pointed cones that returned `Err` on `main` now
succeed — the open cone had been denying the mesh fallback a watertight
operand.

### Offset lane: what #53 landed, and the one measurement it corrected

`offset_solid` refused any solid with inner shells; two sites read only the
outer shell. Both now carry the source's shell partition through. A 6-cube
with a concentric 2-cube void offsets outward 0.5 to `7³ − 1³ = 342` and
inward 0.5 to `5³ − 3³ = 98`, exact to 1e-9. No sign special-case was needed —
a cavity's outward normal already points into the void.

`arc_joint.rs` was a 19-line stub; it now builds true Minkowski joints for
convex polyhedra and refuses everything else with its own reason. Box ⊕ ball
gives exactly 6 planes, 12 cylinders and 8 spheres, `V−E+F = 24−48+26 = 2`,
zero free and zero non-manifold edges. A 2×2×2 at d=0.5 measures
25.2359600939 against a closed form of 25.2359877560 (1.1e-6); **the mitred
fallback it replaces reads 27.0 — 7 % high.** Holds at 1×/1000×/0.001×.

Also fixed a scale-dependent `1e-20` in `loops.rs` that carried the *fourth*
power of model units and killed every corner of a micron-scale body. Five
further hardcoded absolute tolerances remain in `crates/offset`
(`analyse.rs:17`, `assemble.rs:337`, `inter2d.rs:116/127/147/184`,
`inter3d.rs:401/418`); every one **fails closed**, and none trips at 1e-3
scale.

**Self-intersection removal was deliberately not attempted.** Excising a fold
correctly needs the boolean engine's co-refinement, and a partial
implementation would return a closed, oriented, plausible body enclosing the
wrong volume — exactly the failure this whole effort exists to catch.

*The correction, and it is the third time this class has bitten:*
`wire_polygon_sampled` laid a **closed** circle edge down as a polyline but
contributed only one endpoint for an **open** arc — one chord for the whole
arc. A rolling-ball corner patch is bounded by three quarter great circles and
nothing else, so it measured 0.29289322 against `π/2·r² = 0.39269908`,
**25 % low**, and the whole rounded 2×2×2 body 2.0 % low — through *both*
`solid_volume` and `mass_properties`. Fixed in `build_face_uv`.

**Note what this means for the `mass_properties == solid_volume` cross-check:
it would not have caught this, and it never could.** Both routes share
`integrate_face`. They agree exactly for the all-planar mitred results the
existing tests use, and diverge only once a face is bounded by open arcs. The
agreement is structurally blind — use hand-derived closed forms instead. That
fix in turn exposed a fixture bug in #49's regression, where `uv_rect_wire`
built both constant-`v` arcs about `+z` and so declared the **major** arc,
4.283 rad where the test names 2.0; the chord approximation had been hiding it.

### Boolean lane: non-planar coincident contact, reproduced

A **cylindrical face exactly tangent to a planar face of the other operand**
makes a boolean go wrong silently. Every result below is a well-formed solid
that `validateSolid` accepts. Measured against the current pin on a 60×40×8
plate with an r=10, h=16 cylinder, all closed forms exact:

| Case | Result | Error |
| --- | --- | --- |
| Boss tangent to the x=0 wall, `fuseAll` | 6 planes — **the plate alone; the boss is dropped entirely** | −11.57 % |
| `cut` with a tool tangent to the x=0 wall | 6 planes — **the cut is silently ignored, body unchanged** | −15.06 % |
| Boss tangent to the y=0 wall, `fuseAll` | 70 planes — every analytic surface destroyed | −0.019 % |
| Bored plate + tangent boss, `fuseAll` | 115 planes — same, on a body that was 7 analytic faces | −0.010 % |

Sweeping the boss centre across the wall shows **three regimes**, and the
faceting one is far wider than "tangency" suggests. With tangency at x = 10 and
`d` the overlap:

| `d` | Result |
| --- | --- |
| `d > 0` — boss fully inside the wall, from 1e-7 to 1 | correct: 9 faces, a true cylinder, 21713.2741 exact to 1e-10 |
| `d = 0` — exactly tangent | **operand dropped**, 6 planes, 19200.0000 |
| `d < 0` — boss crosses the wall, from −1e-7 to **−1** | **70–71 planes, no cylinder at all**, −0.019 % |

So only the *dropped-operand* case is a knife-edge. The faceting fires for
**any** cylinder that crosses a planar face, at any depth — a boss overhanging
the edge of a plate, a pin protruding through a side wall. That is not an edge
case, it is a common modelling situation.

What makes it stark: the boss axis is vertical and the wall plane contains that
direction, so **cylinder ∩ plane is exactly two straight lines** here. This is
close to the simplest possible curved-planar intersection, and the analytic
path does not take it.

**Planar-planar coincidence is unaffected**: two boxes sharing a face exactly,
and a box boss placed tangent, both come back correct. So this is specific to
the curved-vs-planar contact `boolean/mod.rs:914` names, not to coincidence in
general.

Why it deserves to lead the lane: a boss overhanging the edge of a plate, or a
hole drilled flush with a wall, is ordinary design intent rather than an
adversarial input — and every failure mode here is silent. The dropped-operand
and ignored-cut cases are the same class as the fourteen defects M0–M3 closed:
confident, well-formed, wrong. Note the faceted cases would also be caught by
the `brepkit_approx` census the Hardening row keeps as a CI metric, but the
dropped-operand and ignored-cut cases would **not** — they produce no
approximation at all, just less geometry.

### Measuring defects where the user meets them, not where they live

Every defect above is recorded at kernel level, which is where they get
fixed — but it is not where they get *noticed*, and two of them turned out
to be materially worse when measured through `syncDocument`, on the mesh the
viewport draws and the volume the UI prints. Both are pinned that way now,
each with `it.fails` tests asserting the right answer so they turn red on
the day the kernel stops being wrong.

**A hollowed body reports its volume as if solid**
(`test/hollow-body-volume.test.ts`). An r10 h20 cylinder with a fully
enclosed r4 h8 void comes back as **6283.185307179587** — not approximately
the solid cylinder, *exactly* `π·10²·20` — against a closed form of
5881.061447520093. **6.8 % high, with an empty warnings array.**
`kernel.volume` ignores inner shells; `massProperties` reads the same body
right to 1.2e-9; and the adapter reports every body through the first. That
the number is exactly the un-hollowed volume is what identifies it as a
dropped shell rather than an integration error. Shelling is a core workflow,
so this is wrong in the product today rather than latent.

**A cross-drilled shaft is drawn differently from how it measures**
(`test/cross-drilled-render.test.ts`), and this is **wider than the
kernel-level record**, which described only the equal-radius case:

| bore r | app prints | mesh encloses | boundary edges |
| --- | --- | --- | --- |
| 3 (equal) | 704.263 | **847.724** | 0 |
| 2 | 750.652 | 796.736 | **1542** |
| 1 | 802.579 | 825.382 | **1154** |

Undrilled stock is 848.230; the equal-radius answer is 704.230 by Steinmetz.
So at equal radius the viewport shows a shaft with **no hole** — within
0.06 % of undrilled — while the printed volume says there is one, and the
mesh is watertight so nothing downstream objects. At smaller radii the hole
*is* drawn but the surface **leaks**. The record implicitly treated
non-tangent bores as fine; they are not, they fail differently.

*Two method notes, because both nearly produced a false report.* The first
probe showed a perfect no-op at every radius — identical volume **and**
identical triangle count — which was too clean to be a kernel result: the
transform field is `rotationDeg`, not `rotation`, so the rotation was
silently dropped and the bore sat outside the shaft entirely. Subtracting a
disjoint body *is* correctly a no-op. And the boundary-edge counts mean
nothing until vertices are welded by **position**, because this kernel emits
duplicates at seams and an index-based count reports those as holes; welding
changed nothing here, which is what makes the counts trustworthy.

---

## 6. M5 — Platform (K2, product-sequenced)

- **Assemblies:** mates/joints over the existing transform-tree + BOM;
  assembly interference (pairwise `solidToSolidDistance` + intersect
  volume, both bound); STEP assembly round-trip (K0.1 step 5 grows into
  real structure). OpenZCAD side: multi-part documents (the
  `AssemblyNode`/`PartNode` schema already exists but is fixed at 1×1).
- **Evolution/persistent naming:** ~~promote `evolution.rs` from Beta,~~
  extend to blends/patterns/direct edits so the adapter's hash-only
  lineage classes (boolean, fillet, chamfer, pattern, offset) become
  tracked; this directly upgrades OpenZCAD's fail-closed reference UX.
  **Substantially landed in brepkit#51**, and deliberately NOT promoted off
  Beta — the evidence supports "exact for three operation families,
  scale-invariant and fail-closed elsewhere", not "stable", which would imply
  coverage six operations lack. What landed: the matcher was scale-dependent
  (an absolute `centroid_dist_sq_max = 100.0`, and `UnitSystem` includes
  metres), so at 1000× it reported four *surviving* faces as **deleted** and at
  0.001× reported the two walls a fuse *consumes* as modified into the other
  body's far end caps — a saved pick silently relocating onto different
  geometry, with `deleted` empty so nothing signalled it. Budget is now a
  fraction of the centroids' own bounding diagonal. Ambiguity gets an
  `unresolved` bucket instead of a coin toss, which caught a live case: a
  box-edge fillet's blend face was being recorded as a modified version of
  *both* faces the rounded edge separated. Fillet/chamfer and patterns now
  carry **construction-derived** provenance — the blend builders already held
  it and were discarding it — and `EvolutionMap::origin` lets a consumer tell
  fact from inference. Offset, shell, draft, split, defeature and the direct
  edits still carry none, each stated rather than implied.
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
- **The corpus is not the whole gate — the full suite is.** The bump to
  `70fb561` (kernel #50–#53) was tried and **held**. The parity corpus was
  perfect: 151 passed, `test/parity/baselines/` completely unmoved, so the
  #50 seam-chord change moved no edge hashes and the movement predicted as
  possible did not happen. But `topology-lineage-spike` caught something the
  corpus structurally cannot see: `filletWithEvolution` no longer attributes
  the cylindrical blend band, and the set equality failed with the band in
  the result and in neither `modified` nor `generated`.

  **My first reading of that was wrong, and the correction is the useful
  part.** I reported the band as having "lost its provenance entirely". It
  had not. #51 also **added two fields**, `unresolved` and `origin`, and the
  band sits in `unresolved: {"6":[0,2]}` — explicitly refused, with *both*
  candidate sources named. My probe printed only
  `modified`/`generated`/`deleted` because I wrote it against the old
  three-field schema, and `verifyCompleteBrepEvolution` read the same three,
  which is exactly why it presented as claimed-by-nothing. Verified by
  re-probing both pins and dumping every key.

  Two further corrections, both from the lane that fixed it:

  - **The old answer was not correct-and-deliberate, and must not be
    restored.** `modified: {"0":[6,7], "2":[6,9]}` was an artefact of a
    near-tie rule and actively harmful — a selection stored against face 0
    silently acquired the cylinder, which is the very thing #51's commit
    message documents catching.
  - **`generated` is the right model and never was a contract change.** The
    walking builder always recorded `created: (band, [base_a, base_b])`, the
    cylinder-rim fillet already returned `generated`, and the WASM binding
    already documented that blend faces appear there. The two engines behind
    one operation were disagreeing. The fix makes the geometric matcher reach
    the record's answer: `generated: {"0":[6], "2":[6]}`, `unresolved: {}`.
    Root cause was that the matcher read *every* unresolvable tie as
    ambiguity, when a rolling-ball band ties against both its parents **by
    construction** — that tie is the signature of a face built from both.

  So the defect was a refusal where a fact was available, not silence — and
  weaker than I first described, though still worth fixing, since a consumer
  cannot tell the two apart. **The same gap hit `chamfer`, not just
  `fillet`.**

  Three things to keep. **A count-based assertion would have passed** — the
  face count never changed, only the attribution; set equality is the check,
  not counts. **No topological or geometric check sees it** —
  `validateSolidRelaxed` is 0 and the geometry is right. And **a
  completeness assertion must read every field the record has**: mine was
  written against a schema the kernel had since extended, so it reported the
  right failure for the wrong reason. Pin holds at `f3defc3` until the fix
  lands; **Z6.1 stays blocked**, since it needs #50's cap-rim radius range.
  Note that brepkit has **issues disabled**, so kernel defects are recorded in
  the PR that fixes them, not in a tracker.
- **M3's remaining slices (W2, W3, W4) land as merge commits, not squashes.**
  They come off one long-lived branch in sequence, and a squash makes the
  merged commit a non-ancestor of `main` — so each following slice needs a
  branch restart and a force-push before it can be pushed at all. A merge
  commit keeps the branch fast-forwardable and the slices stackable. This is
  also why Z3 was merged rather than squashed, though for the different reason
  that it advertised `git revert -m 1 1f35ae1` as its revert path.

### The pin-bump mechanics, concretely

1. Merge the brepkit PR. `publish.yml` then runs `cargo xtask wasm-build
   --skip-opt` on `main` and auto-commits `crates/wasm/pkg` as
   `chore(wasm): refresh committed package … [skip ci]`. Wait for that
   commit — the app pin must point at it, not at the feature merge, or it
   will install a package built before the change.
2. In OpenZCAD: `pnpm update brepkit-wasm --lockfile-only --recursive`.
   A plain `pnpm install` will **not** move the pin: `package.json` says
   `github:esaueng/brepkit#main`, and an existing lockfile entry keeps the
   old SHA pinned, which is exactly what a lockfile is for. Expect a diff
   touching only the four `brepkit-wasm` tarball lines.
3. Because CI installs from the lockfile, any app commit that calls a new
   kernel API **must** carry the bump in the same commit, or CI installs a
   kernel without the API and fails.

For local testing ahead of a merge, `cargo xtask wasm-build --skip-opt` in a
brepkit checkout and copy `brepkit_wasm_bg.wasm` into
`node_modules/.pnpm/brepkit-wasm@*/node_modules/brepkit-wasm/`. The `.js`
and `.d.ts` files are hardlinked by pnpm and update in place; the `.wasm`
does not, because wasm-pack rewrites it and breaks the link. Symptom of
getting this wrong: `wasm.brepkernel_<newFn> is not a function`, with the
new function present in the typings.
