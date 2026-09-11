# STEP-to-parameter hammer holder: implementation plan (revised 2026-09-11)

## Goal and definition of done

A user imports the original hammer-holder STEP file into OpenZCAD, attaches the
drawing or selects the relevant geometry, and asks the assistant to expose the
opening width, overall width, height, and mounting-hole diameter. The assistant
measures the actual solid, proposes explicit parameter relationships, and
creates ordinary editable history after exact preflight. Subsequent changes give
a responsive visual preview and eventually a validated exact solid that can be
saved, reopened, undone/redone, and exported to STEP or STL.

The user must not need a prepared project, a developer script, manually entered
cut coordinates, or knowledge of face IDs. The original STEP remains available.
This creates new modeling intent around an imported solid; it does not recover
the original CAD application's feature tree.

First acceptance target: this hammer holder. Next: a bounded family of
geometrically similar holders. Arbitrary STEP models are a later expansion, with
explicit refusal for unsupported geometry.

## Relationship to the guided-reconstruction plan

`docs/plans/guided-reconstruction-plan.md` (approved 2026-08-25) reaches the
same milestone by a different construction: a native parametric twin of the
whole holder, with the import kept as a locked witness. This plan **supersedes
phases R1–R4 of that plan for the hammer profile.** The retained-ends
construction below keeps the import's exact arms, holes, lettering and blends
instead of re-modeling them, so the neck and text approximations that plan
declares are not needed. R0's measurement probes remain in use. R5 and the
`.shapr` evidence path stay deferred. Update the older plan's status line in
the same PR that lands Phase 2 so there is one plan of record.

## Current position (verified 2026-09-11)

- The prepared growing-holder project works. Opening changes move intact arms
  and mounting holes together, preserving arm thickness, hole sizes, lettering,
  fillets, and height. It exists only as the opt-in
  `test/hammer-holder-growing.test.ts`; no production code builds it.
- Opening minimum is 16.1 mm, with no fixed maximum. Outside width is
  opening + 28 mm; hole-center spacing is opening − 6 mm, which is each hole
  center 3.0 mm inboard of its inner face and a 0.5 mm wall to the Ø5 bore.
  These are properties of this measured construction, not universal rules.
- Viewport-only preview is implemented (`apps/web/src/lib/growingHolderPreview.ts`)
  and was observed within roughly 270 ms including automated input. It matches
  the prepared history by shape: exactly seven features, the literal source
  width 46, and the exact expression string `require_min(opening_width, 16.1)`.
  Any other history returns null silently and the preview disappears.
- OpenZCAD PR #275 is merged and auto-deployed. Remus #374, #382 and #389 are
  merged on Remus `main`; #394 is open.
- **The production kernel pin does not correspond to those merges.** The
  lockfile pins Remus `4c2c05de`, a commit on no pull request that is 2 ahead
  and 25 behind Remus `main`. Its history holds #374's content and a pre-rebase
  copy of #382, and none of #389. `docs/imported-hammer-opening.md` and
  `test/fixtures/hammer-holder/README.md` name a third commit, `9bee897f`,
  as the pin. Live behavior is therefore the behavior of an unmerged branch.
- Fresh-import automatic preparation, independent height and hole controls, and
  assistant recognition of this example remain unfinished. The assistant's only
  recipe operation, `add_imported_opening_recipe`, compiles the older
  fixed-outside-width recipe qualified at 46 and 50 mm only.
- **Phase 0 done (PR #282, 2026-09-11):** the pin is Remus `main` f1968568
  (2.130.14) and the docs agree with the lockfile.
- **Phase 3 (PR 3):** `recognizeOpening` produces the recipe from the solid;
  on the hammer it equals the hand-authored one exactly, and the synthetic
  bracket is recognized in all three placements, with a pocket splitting the
  run and an E-shape reported as ambiguous. The kernel `section` query
  reports silhouettes on NURBS solids and is not used; the straight run is
  proved by a slab intersection instead.
- **Phase 2 (PR 2, merged as #283):** `growingHolderCommand` compiles a measured recipe into
  history and the preview reads the recipe back; see
  `docs/imported-hammer-growing.md`. Two findings shape Phase 3: the kernel's
  plane `split` cannot cross the section's cylindrical corners, so the ends are
  carved with box-mask intersections from two references to the import; and
  `split`'s volume-conservation check also fails on the synthetic bracket in
  every orientation, so `split` is not usable for recognition probes either.

## Parameter contract

| Control | Initial value | Intended behavior |
|---|---:|---|
| opening_width | 46 mm | Move both arms and their mounting holes symmetrically; change the straight bridge length. |
| overall_width | 74 mm | **Derived, read-only:** `opening_width + 28` while arm thickness stays fixed. Shown as a dimension, never offered as an input. |
| holder_height | 58 mm | Change arm height while preserving the mounting base, hole geometry, lettering, and top blends wherever a safe construction can be proven. |
| hole_diameter | 5 mm | Change both matched through bores together, preserving their alignment with the arms. |

Opening and overall width are one degree of freedom under the agreed
fixed-thickness behavior. Editing overall width to drive the opening would be
inverse solving, which the parameter system does not do; it is out of scope.
Independent overall-width and opening controls would require a separate
arm-thickness parameter and an explicitly different modeling mode.

The Ø9 feature on each hole is a 45° countersink, not a flat recess. The
contract holds the **countersink diameter (Ø9) fixed**; widening the through
bore therefore shortens the countersink depth. If the countersink is ever to
follow the bore, that is a separately proposed linked control.

The 16.1 mm minimum is the baseline for the existing bore and countersink
geometry. Once hole diameter is adjustable, derive the minimum from the measured
bore and countersink envelopes, the 0.5 mm wall rule, bridge length, and
surrounding wall clearances. Do not keep a fixed minimum that becomes unsafe
with larger holes. There is no arbitrary maximum, but finite arithmetic, kernel
limits, and exact validity still apply. Geometric clearance is not a structural
strength certification.

## Phase 0 — Pin the kernel to merged Remus

Owner: OpenZCAD dependency workflow.

1. Re-pin `remus-wasm` and `remus-wasm-io` to a Remus `main` commit that
   contains #374, #382 and #389 (and #394 once merged), using the
   lockfile-only updater `.github/workflows/update-remus.yml`. Do not hand-edit
   the resolved SHA.
2. Correct the two docs that name `9bee897f` so they name the actual pin.
3. Run the full CI matrix, especially `pnpm test:parity-corpus` and Playwright,
   and the opt-in hammer tests locally at 46 and 55 mm.

Exit: origin/main's pin is an ancestor-of-`main` Remus commit, docs agree with
the lockfile, and the growing-holder opt-in test passes on it. This is a
one-PR prerequisite for every phase below.

## Phase 1 — Stabilize and measure the existing exact pipeline

Owner: Remus for kernel changes; OpenZCAD for integration and browser measurements.

1. Finish the already-running Remus investigation without duplicating it.
   Profile the full adapter operation, not only raw fuseAll: construction,
   unification, overlap proofs, validation, tessellation, and volume/mass
   integration.
2. Review the optimization PRs and their dependency order. Require unchanged
   geometry checks and reproducible cold/warm measurements.
3. Land each accepted optimization through Phase 0's pin workflow in a narrow PR.
4. Benchmark 16.1, 20, 35, 46, 50, 55, and 1000 mm plus repeated edits. Record
   the hardware, browser, package SHA, geometry complexity, and timings for
   each stage.
5. Confirm that preview startup, exact completion, save/export, and
   cancellation remain correct. Retain the preview even when exact operations
   become faster.

Exit: a validated optimization pin and a before/after end-to-end browser report.
A raw-fuse speedup alone does not satisfy this phase. Define exact-rebuild
latency targets from that measured baseline; a few-second typical edit is an
objective, not an established capability.

## Phase 2 — Make the prepared construction a production service

Owner: OpenZCAD document/adapter layers. This is PR 2 and takes a **measured
recipe descriptor as input**; it does not infer anything from the solid.

1. Define the descriptor: source identity and checksum, local coordinate
   frame, opening axis, the two cut planes, the retained end regions, the
   bridge section profile and its plane, symmetry center, the width expression
   and its derived minimum, and feature provenance. Version it additively.
2. Extract the opt-in test's construction into a `packages/command-system`
   compiler: descriptor + document → ordinary history (two retained ends,
   bridge sketch and extrusion, two symmetric moves, one union) plus the
   `opening_width` and derived `overall_width` parameters. Separate
   measurement, proposal, compilation, and exact execution.
3. End-piece persistence, decided: the ends are derived at rebuild from the
   original import (option b), as box-mask intersections rather than plane
   splits, because the kernel split cannot cross curved section faces. The
   positive end needs a second reference to the import; production imports are
   content-addressed source references, so that duplicates a reference, not the
   bytes. The carving features read no parameter and keep their checkpoints
   across opening edits. No STEP payload enters Git and header privacy
   sanitization applies.
4. Perform exact splitting and construction inside the browser geometry
   worker. Keep feature intent and history in the document model.
5. Preserve original source data and stable semantic references. Rebuilding
   resolves references from source/construction evidence, not array indices or
   transient handles.
6. Compile the descriptor into history and apply it atomically after
   successful exact preflight. Failure leaves the original document intact.
7. **Carry the preview with it.** Replace the seven-feature shape matcher with
   a preview descriptor the compiler emits: retained meshes, rigid transforms,
   and the proven stretch section. The preview must not depend on a literal
   feature count, the source width literal, or the expression text. Add a test
   that the compiled history of a synthetic descriptor still yields a preview.
8. Keep saved-project compatibility; do not silently rewrite older
   fixed-outside-width recipes or the existing prepared project.

Exit: production code turns the original imported solid plus a hand-authored
descriptor into the current growing recipe, with the preview intact, without a
developer script or prepared backup. Hammer descriptor lives in the opt-in test;
a synthetic U-bracket descriptor runs in CI. At the original dimensions, verify
preservation of the source geometry using geometric witnesses and analytic
checks (the planar/cylindrical bridge core integrates exactly; whole-body
volume is tessellation-dependent and is not an identity oracle).

## Phase 3 — Recognize the hammer's editable regions

Owner: Remus measurement capabilities and OpenZCAD recognition. Produces the
Phase 2 descriptor from the solid.

1. Reuse the R0 measurement probes: analytic inventory, symmetry detection,
   parallel-plane spacing.
2. Detect a candidate opening axis, opposite inner arm surfaces, symmetry,
   cylindrical mounting bores with countersinks, and a straight connecting
   section.
3. Identify safe cut and stretch regions that avoid bores, blends, lettering,
   and freeform details. Prove that the proposed bridge section represents the
   actual source.
4. Normalize placement and units. Equivalent translated/rotated imports must
   produce equivalent descriptors.
5. Classify each candidate as measured, ambiguous, unsupported, or proven
   editable. A visual resemblance is not enough to claim editability.
6. Run bounded exact edit probes in a disposable worker context. Show progress,
   support cancellation, and cap face, candidate, and probe budgets; WASM cannot
   be interrupted, so budgets are the only defense.
7. When recognition is ambiguous, highlight candidates and request a focused
   selection of the intended faces or axis. Do not require raw face IDs or
   numerical region boxes.

Exit: the actual fresh hammer import reliably yields a descriptor equivalent to
the hand-authored one (same cut planes, section, and 46 mm opening within
tolerance); unrelated solids and uncertain regions are refused or sent to the
guided selection flow.

## Phase 4 — Connect drawing intent to an assistant proposal

Owner: assistant contracts and application UI.

1. Accept a request such as "Parameterize the dimensions in this drawing."
   Interpret the 46/74/58/Ø5 annotations as requested design intent, then
   compare them with measurements of the STEP solid.
2. Treat attachment text as document content, not instructions to execute
   tools or change project policy.
3. Extend the existing `add_imported_opening_recipe` seam in
   `packages/ai-contracts`: add a growing-recipe operation whose only free
   inputs are the target body and the recognition result reference. The
   assistant never supplies cut planes, regions, or section geometry. Mark the
   fixed-width operation deprecated for new proposals; keep it replayable for
   existing documents.
4. Present a proposal with parameter names, measured values, linked
   dimensions, intended movement, inferred limits, and any unsupported
   controls.
5. Highlight the affected faces and retained regions. Explain that the arms
   and mounting holes move together when the opening changes, and that overall
   width is derived.
6. Apply the accepted proposal as one undoable transaction after exact
   preflight. Show a concrete reason if it fails and retain the original model.

Exit: import STEP → attach drawing/request → review a measured proposal →
apply → edit opening_width, with no manual preparation.

## Phase 5 — Add hole diameter, then height, one at a time

Owner: Remus edit capabilities and OpenZCAD feature compilation. Hole first,
because most of it already exists.

Hole diameter:
- Apply the existing ADR-010 direct-edit through-hole resize (fail-closed
  geometric fingerprints) to each retained end piece, grouped as one
  `hole_diameter` control. Only if that path refuses on this geometry does
  a new Remus capability get scoped.
- Hold the Ø9 countersink diameter fixed per the contract; validate
  through-hole continuity, countersink compatibility, wall thickness, and
  collision clearance.
- Recompute the opening minimum from the new bore envelope and the 0.5 mm wall
  rule; reject widths that the new minimum forbids.

Height:
- Identify a safe straight arm section between the base and the hook curl,
  excluding the lettering on the left inner face. Preserve the base, and
  translate the upper end while adjusting only that section.
- Establish geometric limits for shortening. Preserve lettering and blends
  rather than stretching the entire mesh or scaling the whole body.
- Refuse unsupported shapes or ranges instead of silently deforming protected
  details.

Composition:
- Establish a deterministic construction order and semantic references so hole
  and height changes remain attached to the correct ends as width changes.
- Test combinations, not merely each parameter alone.

Exit: all requested independent controls work together; overall width stays a
derived dimension of opening width.

## Phase 6 — Extend the preview to the new controls

Owner: OpenZCAD frontend/viewport. The descriptor-based preview itself lands in
Phase 2; this phase widens it.

1. Extend preview support to height and hole edits only where a trustworthy
   visual approximation is available. Keep unsupported changes on the
   exact-only path.
2. Keep preview meshes outside persisted geometry, exact topology selection,
   measurements, and exports. Show that exact validation is pending.
3. Always compute rapid changes from the last validated baseline, not from the
   previous approximate preview. Discard out-of-date worker responses.
4. Handle undo/redo, project switching, hidden bodies, invalid parameters,
   worker failure, and cancellation. Coalesce input deliberately.
5. Measure input-to-preview latency on specified hardware. Target sub-100 ms
   presentation after a warm baseline; the observed ~270 ms automated
   interaction is current evidence, not a guarantee.

Exit: responsive previews for supported edits, no stale-result overwrite, and
verified handoff to exact geometry. Initial loading may still require a full
exact build.

## Phase 7 — Persistence, export, and complete acceptance

Owner: OpenZCAD integration/testing.

Use the original private source locally and a redistributable synthetic corpus
in CI. Never publish the private STEP without authorization.

Required cases:
- Fresh import and assistant proposal; duplicate names; rotated/translated
  input; equivalent units; unsupported models and ambiguous drawings.
- Source dimensions, derived minimum, just-below-minimum, representative
  intermediate and large widths, invalid expressions, and non-finite inputs.
- Height and bore limits, derived overall width, parameter combinations,
  symmetry, protected details, and hole placement.
- Rapid edits, undo/redo, invalid-edit recovery, worker interruption, stale
  responses, and project switching.
- Save/reopen, project backup/import, source availability after reopening,
  STEP reimport, and closed STL output.
- Strict solid validity, connectedness, analytic-surface preservation, expected
  bounds, hole witnesses, and closed/oriented tessellation. Do not substitute a
  loose global volume assertion for geometry preservation.
- Existing documents, the deprecated fixed-width recipe, unrelated CAD
  features, and exported-file compatibility.

Run the repository's required lint, typecheck, root and web tests, parity
corpus, production build/bundle checks, and Playwright gates. Preserve all
existing assertions. Read `validate`, `e2e`, and `Cloudflare version / verify`
from the PR head's own check runs before an authorized merge; do not trigger
Apple Silicon CI unless requested.

Exit: a recorded fresh-import-to-export browser walkthrough passes on the
release candidate, with no prepared-project shortcut.

## Phase 8 — Release and expand

1. Merge validated dependencies in order through the Phase 0 pin workflow.
2. Distinguish merge, automatic deployment (every merge to `main` deploys
   zcad.app), live build metadata/health, and actual production browser
   behavior.
3. Perform the complete hammer flow on zcad.app and publish a short
   supported-controls/limits guide.
4. Expand to additional holder variants only after the hammer passes. Add each
   new geometry family with recognition evidence, bounded construction rules,
   and regression examples.

Exit: the original goal is usable on the deployed site, with documented
supported cases and honest refusal for unsupported geometry.

## Execution order and next deliverables

Phase 0 precedes everything. The Remus investigation (Phase 1) and the app-side
productionization (Phase 2) then proceed independently. Recognition (3) depends
on the descriptor interface from 2; the assistant flow (4) depends on 3; hole
and height controls each need their own exact proof before combined acceptance.

PR sequence:
0. Remus re-pin to merged `main` plus doc correction.
1. Validated Remus performance integration (may be several narrow pins).
2. Descriptor-to-history growing-holder compiler, end-piece persistence, and
   the descriptor-based preview.
3. Opening recognition with guided selection fallback.
4. Fresh-import assistant proposal and atomic apply flow.
5. Grouped bore control via existing direct-edit, and coupled clearance limits.
6. Height control and its limits.
7. Preview for the new controls and complete lifecycle coverage.
8. Production acceptance and user documentation.

Every PR branches from `origin/main`, never from a stale local `main` or an
existing feature worktree. The immediate OpenZCAD tasks are PR 0 and PR 2. The
primary next milestone is a fresh STEP import becoming an opening-width
parameter through the assistant, without the prepared project. Do not delay
that milestone to attempt universal feature-tree reconstruction.
